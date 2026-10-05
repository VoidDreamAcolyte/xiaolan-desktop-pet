'use strict';

/**
 * ============================================================================
 * 测试辅助：假 fetch / 假定时器 / 假 fs / 假子进程
 * ============================================================================
 *
 * 阶段 4 的 ASR / TTS 客户端要验证的内容很多（endpoint、请求体、超时、重试、
 * 错误归类、不泄密），但**绝不能发真实网络请求**，也不该为了验证超时真的等 10 秒。
 * 所以这里集中提供几套可复用的假实现：
 *
 *   - createFakeFetch：按脚本依次返回响应 / 抛错 / 卡住，并记录每次请求的
 *     url / init（含 headers 与 body），便于断言 endpoint、Authorization、
 *     以及"有没有手动设置 Content-Type"。
 *   - createFakeTimers：假定时器（毫秒级触发超时），支持手动推进。
 *   - createMemoryFs：内存文件系统，支持 existsSync / readFileSync / writeFileSync /
 *     renameSync / unlinkSync / mkdirSync / readdirSync / statSync。
 *   - createFakeExecFile：记录 execFile 的 (file, args, options)，并声明
 *     "有没有传 shell"。
 *   - fakeFormData / fakeBlob：最小可用的 FormData / Blob 替身，
 *     用来检查 multipart 表单里到底 append 了什么。
 *
 * 本文件只在测试里 require，不属于产品代码。
 */

/**
 * 造一个按脚本行事的假 fetch。
 *
 * @param {Array<object|Function>} script 每一项依次对应第 1、2、3…次调用：
 *   - `{status, body, mode}`：返回响应（mode: 'text' | 'json' | 'buffer'）；
 *   - `{throw: Error}`：抛异常（模拟网络错误）；
 *   - `{hang: true}`：永远不 resolve（用来验证超时）。
 *   脚本用完后重复使用最后一项。
 */
function createFakeFetch(script) {
  const calls = [];
  const list = Array.isArray(script) && script.length > 0 ? script : [{ status: 200, body: '' }];
  let index = 0;

  const fetchImpl = (url, init) => {
    const step = list[Math.min(index, list.length - 1)];
    index += 1;
    calls.push({
      url: url,
      method: init && init.method ? init.method : 'GET',
      headers: Object.assign({}, (init && init.headers) || {}),
      body: init ? init.body : undefined,
      hasSignal: Boolean(init && init.signal)
    });

    const signal = init && init.signal ? init.signal : null;

    /** 造一个"会被 abort 拒绝"的 Promise（模拟真实 fetch 的 AbortError） */
    const makeAbortPromise = () =>
      new Promise((_resolve, reject) => {
        if (!signal) return;
        const failAbort = () => {
          // 用 setImmediate 让拒绝异步到达：真实 fetch 的 reject 也不会在
          // abort() 调用栈里同步发生；同步拒绝会让重试路径"跑在 flush 循环内部"，
          // 把新注册的超时定时器漏在循环外（测试会挂死）。
          setImmediate(() => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            reject(error);
          });
        };
        if (signal.aborted) {
          failAbort();
          return;
        }
        if (typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', failAbort);
        }
      });

    /**
     * 让某个 Promise 与 abort 竞争：谁先落定谁说话。
     * 读 body 卡住（hangBody）时必须走这条，否则 abort 后 body read 永远不返回，
     * 被测代码就会挂死（测试既不会失败也不会结束 —— 那是假的通过）。
     */
    const raceAbort = (promise) => {
      if (!signal) return promise;
      return Promise.race([promise, makeAbortPromise()]);
    };

    if (step.hang === true) {
      /*
       * 模拟"请求永远不返回，但支持被 abort"：
       * 真实 fetch 会在 signal 触发时 reject 一个 AbortError，
       * 只有这样才能验证"超时 → abort → 归类 timeout → 重试"的完整链路。
       */
      return makeAbortPromise();
    }
    if (step.throw) {
      return Promise.reject(step.throw);
    }

    const status = Number.isFinite(step.status) ? step.status : 200;
    const response = {
      status: status,
      ok: status >= 200 && status < 300
    };
    const body = step.body;
    response.text = () => {
      if (step.hangBody === true) return raceAbort(new Promise(() => {}));
      if (typeof body === 'string') return Promise.resolve(body);
      if (body === undefined || body === null) return Promise.resolve('');
      return Promise.resolve(JSON.stringify(body));
    };
    response.arrayBuffer = () => {
      if (step.hangBody === true) return raceAbort(new Promise(() => {}));
      if (body instanceof Uint8Array) return Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
      if (typeof body === 'string') return Promise.resolve(new TextEncoder().encode(body).buffer);
      if (body && body.buffer) return Promise.resolve(body.buffer);
      return Promise.resolve(new ArrayBuffer(0));
    };
    response.json = () => Promise.resolve(body);
    return Promise.resolve(response);
  };

  return { fetchImpl, calls };
}

/**
 * 造一个"假定时器"：注册的回调不会自动执行，要靠 flush 手动推进。
 * 用于验证超时逻辑（毫秒级跑完，不真的等 10 秒）。
 */
function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const cleared = [];

  return {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      pending.delete(id);
    },
    /**
     * 立刻执行所有待触发的定时器回调。
     *
     * 注意：重试场景里"第一次请求超时"会在超时回调之后**同步注册**第二次请求的
     * 超时定时器，所以这里要循环推进，直到没有新的待触发定时器为止；
     * 否则第二次请求会永远挂在"假定时器还没触发"的状态里（测试死等）。
     *
     * 更复杂的情况（超时 → abort 拒绝 → 重试注册新定时器是异步的）请用
     * `flushAsync()`：它会在每轮之间让出宏任务，等待重试链自己注册出新的定时器。
     */
    flush() {
      let total = 0;
      let guard = 0;
      while (pending.size > 0 && guard < 1000) {
        guard += 1;
        const items = Array.from(pending.entries());
        pending.clear();
        for (const [, item] of items) item.fn();
        total += items.length;
      }
      return total;
    },
    /**
     * 异步版：反复"触发定时器 + 让出宏任务"，直到连续两轮都没有新的待触发定时器。
     * 用于验证超时重试（重试请求的定时器是异步注册的）。
     */
    async flushAsync() {
      let total = 0;
      let idleRounds = 0;
      for (let i = 0; i < 100 && idleRounds < 2; i += 1) {
        const count = this.flush();
        total += count;
        if (count === 0 && pending.size === 0) idleRounds += 1;
        else idleRounds = 0;
        // 让出宏任务：让被 abort 的 fetch 拒绝并让重试路径注册出新的定时器
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setImmediate(resolve));
      }
      return total;
    },
    get pendingCount() {
      return pending.size;
    },
    get clearedIds() {
      return cleared.slice();
    }
  };
}

/**
 * 造一个内存文件系统（够用就好，只实现这几个模块真正用到的 API）。
 */
function createMemoryFs() {
  const files = new Map();
  const dirs = new Set();
  const operations = [];

  return {
    files,
    dirs,
    operations,
    existsSync(path) {
      return files.has(path) || dirs.has(path);
    },
    readFileSync(path) {
      if (!files.has(path)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(path);
    },
    writeFileSync(path, data) {
      files.set(path, typeof data === 'string' ? data : String(data));
      operations.push({ op: 'write', path });
    },
    renameSync(from, to) {
      if (!files.has(from)) throw new Error('ENOENT');
      files.set(to, files.get(from));
      files.delete(from);
      operations.push({ op: 'rename', from, to });
    },
    unlinkSync(path) {
      if (!files.has(path)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      files.delete(path);
      operations.push({ op: 'unlink', path });
    },
    mkdirSync(path) {
      dirs.add(path);
      operations.push({ op: 'mkdir', path });
    },
    readdirSync(path) {
      void path;
      return Array.from(files.keys()).map((file) => file.split(/[\\/]/).pop());
    },
    statSync(path) {
      if (files.has(path)) {
        return { size: String(files.get(path)).length, mtimeMs: 1 };
      }
      if (dirs.has(path)) return { size: 0, mtimeMs: 1 };
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
  };
}

/**
 * 造一个假的 execFile：记录每次调用的 (file, args, options)，并按脚本返回结果。
 * 关键断言点是 **options.shell 必须是 false / 未设置**，且用户文本不落在 args 里。
 *
 * @param {Array<object|Function>} script 每项：{stdout, error}；也可以是函数 (file,args,opts)=>result
 */
function createFakeExecFile(script) {
  const calls = [];
  const list = Array.isArray(script) && script.length > 0 ? script : [{ stdout: '' }];
  let index = 0;

  const execFileImpl = (file, args, options, callback) => {
    const step = list[Math.min(index, list.length - 1)];
    index += 1;
    const record = { file, args: Array.isArray(args) ? args.slice() : args, options: options || {}, stdin: null };
    calls.push(record);

    let stdinText = null;
    const child = {
      stdin: {
        on() {},
        end(text) {
          stdinText = text;
          record.stdin = text;
        }
      },
      on() {}
    };

    // 异步回调，模拟真实子进程的时序
    setImmediate(() => {
      const result = typeof step === 'function' ? step(file, args, options) : step;
      if (callback) callback(result.error || null, result.stdout === undefined ? '' : result.stdout);
    });

    return child;
  };

  return { execFileImpl, calls };
}

/**
 * 最小可用的 FormData 替身：只记录 append 的内容，不做真正的编码。
 */
function createFakeFormData() {
  const entries = [];
  function FakeFormData() {
    this.entries = entries;
  }
  FakeFormData.prototype.append = function append(name, value, filename) {
    entries.push({ name, value, filename });
  };
  FakeFormData.prototype.get = function get(name) {
    const found = entries.find((entry) => entry.name === name);
    return found ? found.value : null;
  };
  FakeFormData.prototype.has = function has(name) {
    return entries.some((entry) => entry.name === name);
  };
  FakeFormData.entriesRef = entries;
  return FakeFormData;
}

/** 最小可用的 Blob 替身 */
function createFakeBlob() {
  function FakeBlob(parts, options) {
    this.parts = parts;
    this.type = (options && options.type) || '';
    this.size = 0;
    for (const part of parts || []) {
      if (part && typeof part.byteLength === 'number') this.size += part.byteLength;
      else if (part && typeof part.length === 'number') this.size += part.length;
    }
  }
  return FakeBlob;
}

module.exports = {
  createFakeFetch,
  createFakeTimers,
  createMemoryFs,
  createFakeExecFile,
  createFakeFormData,
  createFakeBlob
};
