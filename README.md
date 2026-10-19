# jscd-electron-support

Electron (pointer-compressed V8) support patches & tooling for
[ejfkdev/jscd](https://github.com/ejfkdev/jscd) — the bytenode `.jsc` (V8 code cache) decompiler.

**Problem**: official jscd tables are built from official Node releases (x64, no pointer compression, `tagged_size=8`). Electron x64 builds run pointer-compressed + sandboxed V8 (`tagged_size=4`): same V8 version number, same `version_hash`, different `flag_hash` and a structurally different serialized layout — jscd rejects these payloads with *"supported but the payload did not survive"*.

**Status**: 12 fixes (Rust) + a pointer-compression layout table for V8 13.6 (Electron 36/37). Validated on a real Electron 36.9.5 app: all 19 `.jsc` modules (194 KB main process incl.) decompile to readable JS (~19k lines); official Node 24.12 files still decompile (dual-table selection).

## English summary

The serialization deltas between compressed and uncompressed builds that this patch set handles:

| # | Where | Fix |
|---|---|---|
| 1 | serializer.rs | object-size unit = `max(tagged_size, 4)` (V8 `kObjectAlignmentBits = kTaggedSizeLog2`; was hardcoded 8) |
| 2 | serializer.rs | 4-byte Smi decode: tag bit is `bit0 == 0` (dead-wrong branch, never exercised by official Node which always takes the 8-byte path) |
| 3 | serializer.rs | `CodeCache::deref_weak` — unwrap `kIndirectPointerPrefix` / `kProtectedPointerPrefix` WeakRef (sandbox trusted pointers) |
| 4 | cli/disasm/decompile.rs | 7 slot-resolution sites unwrap through `deref_weak` (SFI→BytecodeArray / constant pool / handler table / name slots) |
| 5 | disasm.rs / decompile.rs | `BytecodeArray.length`: ts==4 reads the 4-byte Smi at the table offset (`>>1`); ts==8 keeps the `read_u64>>32` path |
| 6 | cli.rs | dual-table candidates for one `version_hash` (node table + `_pc` table; structural gate picks the right one) |
| 7 | decompile.rs | ScopeInfo `position_info_early` offsets `2*ts / 3*ts` (compressed builds have no 4-byte `optional_padding`; `ts+8/ts+16` was an ts8 specialization) |
| 8 | decompile.rs | ScopeInfo outer-scope scan bounded by actual object slots (modern ScopeInfo has no length field; flags were misread as length) |
| 9 | table | `string_length_offset=8 / string_chars_offset=12` for compressed OneByteString (defaults 12/16 are ts8) |
| 10 | cli.rs | bracket-balance gate downgraded to warning |
| 11–12 | tables.rs / tables_embed.rs | `table_by_file` helper + embedded `_pc` table |

### BytecodeArray compressed layout (from `bytecode-array.tq`, empirically verified)

```
map@0(4) self_indirect_pointer@4 length@8(Smi,4B) wrapper@12
source_position_table@16 handler_table@20 constant_pool@24   (ProtectedPointer = 4B)
frame_size@28(u32) parameter_size@32(u16 count) max_arguments@34(u16)
incoming_new_target@36(i32) bytes@40
```

## 使用方法(中文)

```bash
git clone --depth 1 https://github.com/ejfkdev/jscd jscd
cd jscd
git apply /path/to/jscd-electron-support/patch/jscd-electron.patch
cp /path/to/jscd-electron-support/tables/v13_6_pc.json tables/
cargo build --release
./target/release/jscd your-electron-app/main/index.jsc out.js
```

Windows build note: WSL + `rsproxy.cn` mirrors work out of the box when
`sh.rustup.rs` times out; use `wsl -u root -- apt-get install -y build-essential pkg-config`
(default WSL user `sudo` may hang on password).

## 为其他 V8 版本生成 `_pc` 表

jscd's own `scripts/codegen.py` is already parameterized — it just was never invoked
with a compressed config:

```python
import importlib.util, sys, os
spec = importlib.util.spec_from_file_location('cg', 'jscd/scripts/codegen.py')
cg = importlib.util.module_from_spec(spec); spec.loader.exec_module(cg)
cg.extract_tagged_size = lambda tag: 4        # <- force pointer compression
sys.argv = ['codegen.py', '--tag', 'v24.12.0', '--out', '../tables_gen_e']  # pick the Node tag matching your Electron's V8
os.makedirs('../tables_gen_e/tables', exist_ok=True); cg.main()
```

Then hand-fix `bytecode_array` fields to the table above and add
`string_length_offset` / `string_chars_offset`. Calibrate with a differential
experiment: compile the same tiny source under both your Electron
(`ELECTRON_RUN_AS_NODE=1 app.exe`) and stock Node with the same V8 — the stock
file must decompile with stock jscd (your ground truth); byte-diff the two
payloads to find the first structural divergence.

## tools/

| Script | Purpose |
|---|---|
| `extract_jsc_strings.py` | Pull constant-pool strings (ASCII + CJK) out of any `.jsc`. Includes a statistical filter against pseudo-CJK artifacts produced by byte-paired ASCII. |
| `introspect.cjs` | Generic dynamic harness: run an app's own `electron.exe` with `ELECTRON_RUN_AS_NODE=1`, mock the `electron` module (self-healing proxies), load `out/main/index.jsc`, enumerate every `ipcMain.handle` channel, and drive them from a `driver.json` script — all `evt:*` broadcasts land in `events.jsonl`. See the header comment for usage. |

The harness technique works for **any** bytenode-protected Electron app and is
usually enough to recover exact business-rule semantics without decompiling.

## Validation

- Electron 36.9.5 (V8 13.6.233.17-electron.0, `flag_hash` 0xaf3c69a9): 19/19 `.jsc` decompiled, incl. the 194 KB main process (9,686 lines); function bodies, constant pools, strings, scopes all recovered.
- Stock Node 24.12.0 (`flag_hash` 0x1c7c619b) regression: still decompiles (dual-table selection).
- Cross-checked decompiled logic against live dynamic behavior — vote dedup, score arithmetic, tie-breaking all match.

Known cosmetic issues: some long CJK strings render truncated; function names
come out as `_anon_N` (ScopeInfo function_name not yet wired); occasional
unbalanced braces in complex control flow (gate is a warning).

## License

MIT, same as upstream jscd. Patch authored 2026-10; upstreamed fixes welcome —
feel free to lift the whole patch into ejfkdev/jscd.
