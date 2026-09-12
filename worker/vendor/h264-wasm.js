// workerd forbids compiling wasm from bytes at runtime, so the encoder's wasm
// ships as a real module (compiled at deploy) and is handed to the emscripten
// glue through its instantiateWasm hook. This module must be imported BEFORE
// h264.cjs: the factory in there runs at import time and reads this config.
import mod from "./h264.wasm";

globalThis.__H264_CFG__ = {
  instantiateWasm: (imports, done) => {
    const inst = new WebAssembly.Instance(mod, imports);
    done(inst);
    return inst.exports;
  },
};
