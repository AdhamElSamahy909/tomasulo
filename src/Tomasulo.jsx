import React, { useState, useReducer } from "react";
import {
  SkipForward,
  RotateCcw,
  Cpu,
  Database,
  Layers,
  MemoryStick,
  ArrowRight,
  Save,
  Terminal,
  Play,
  Settings,
  Code,
} from "lucide-react";

// --- CONSTANTS & CONFIG ---

const DEFAULT_CONFIG = {
  rsSize: { ADD: 3, MULT: 2, LOAD: 3, STORE: 3 },
  latencies: {
    "L.D": 2,
    "L.S": 2,
    LW: 2,
    LD: 2,
    "S.D": 2,
    "S.S": 2,
    SW: 2,
    SD: 2,
    "ADD.D": 2,
    "ADD.S": 2,
    "SUB.D": 2,
    "SUB.S": 2,
    ADDI: 2,
    SUBI: 2,
    DADDI: 2,
    DSUBI: 2,
    DADDIU: 2,
    DSLTU: 2,
    "MUL.D": 10,
    "MUL.S": 10,
    "DIV.D": 40,
    "DIV.S": 40,
    BNE: 1,
    BEQ: 1,
    BNEZ: 1,
    BEQZ: 1,
  },
  cache: {
    enabled: true,
    size: 64, // Total bytes
    blockSize: 8, // Bytes per block
    hitLatency: 1,
    missPenalty: 10,
  },
  memorySize: 256, // Total Memory Size in Bytes
};

const DEFAULT_CODE = `S.D F6, 0(R2)
DADDIU R1, R1, 8
DADDIU R2, R2, 8
DSLTU R3, R1, R4
BNEZ R3, foo
foo:`;

// --- UTILS ---

const parseInstruction = (line) => {
  const cleanLine = line.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!cleanLine || cleanLine.startsWith(";")) return null;

  const parts = cleanLine.split(":");
  let label = null;
  let instruction = parts[0].trim();

  if (parts.length > 1) {
    label = parts[0].trim();
    instruction = parts[1].trim();
  }

  if (!instruction) return { type: "LABEL", label };

  const tokens = instruction.split(" ");
  const op = tokens[0].toUpperCase();

  let type = "ALU";
  if (["L.D", "L.S", "LW", "LD"].includes(op)) type = "LOAD";
  else if (["S.D", "S.S", "SW", "SD"].includes(op)) type = "STORE";
  else if (["BNE", "BEQ", "BNEZ", "BEQZ"].includes(op)) type = "BRANCH";

  return {
    text: instruction,
    label,
    op,
    tokens: tokens.slice(1),
    type,
  };
};

const toBinary32 = (num) => {
  return (num >>> 0).toString(2).padStart(32, "0");
};

// --- SIMULATOR LOGIC ---

const generateInitialState = (config, codeText) => {
  const lines = codeText.split("\n");
  const instructions = [];
  const labels = {};

  let pIdx = 0;
  lines.forEach((line) => {
    const parsed = parseInstruction(line);
    if (parsed) {
      if (parsed.label) labels[parsed.label] = pIdx;
      if (parsed.type !== "LABEL") {
        instructions.push({ ...parsed, id: pIdx });
        pIdx++;
      }
    }
  });

  // Second pass: Resolve Branch Targets
  instructions.forEach((inst) => {
    if (inst.type === "BRANCH") {
      let labelTokenIdx = -1;
      let labelName = null;
      if (["BNEZ", "BEQZ"].includes(inst.op)) labelTokenIdx = 1;
      else labelTokenIdx = 2;

      if (inst.tokens[labelTokenIdx]) {
        labelName = inst.tokens[labelTokenIdx];
        if (labels[labelName] !== undefined) {
          inst.tokens[labelTokenIdx] = labels[labelName].toString();
          inst.text = `${inst.op} ${inst.tokens.join(", ")}`;
        }
      }
    }
  });

  const regs = {};
  for (let i = 0; i < 32; i++) regs[`R${i}`] = { val: 0, qi: null };
  for (let i = 0; i < 32; i++) regs[`F${i}`] = { val: 0.0, qi: null };

  // Default values
  regs["R1"].val = 0;
  regs["R2"].val = 0;
  regs["R4"].val = 32;
  regs["F6"].val = 99.0;

  const memory = {};
  for (let i = 0; i < config.memorySize; i += 4) {
    memory[i] = 0;
  }

  const rs = {};
  Object.keys(config.rsSize).forEach((type) => {
    rs[type] = Array.from({ length: config.rsSize[type] }, (_, i) => ({
      id: `${type}${i + 1}`,
      type,
      busy: false,
      op: "",
      vj: null,
      vk: null,
      qj: null,
      qk: null,
      address: null,
      timer: 0,
      state: "IDLE",
      instIdx: -1,
      result: 0,
    }));
  });

  const numBlocks = config.cache.size / config.cache.blockSize;
  const cache = Array.from({ length: numBlocks }, (_, i) => ({
    index: i,
    valid: false,
    tag: null,
    data: null,
    history: [],
  }));

  return {
    clock: 0,
    pc: 0,
    instructions,
    labels,
    config,
    rs,
    regs,
    memory,
    cache,
    instStatus: [],
    iteration: 1,
    branchStall: false,
    stalledPc: null,
  };
};

const reducer = (state, action) => {
  if (action.type === "EXIT") return null;
  if (action.type === "RESET")
    return generateInitialState(action.config, action.code);

  if (action.type === "STEP") {
    let next = JSON.parse(JSON.stringify(state));
    next.clock++;
    next.stalledPc = null;

    // --- PHASE 1: WRITE RESULT (CDB Arbitration) ---
    const writeCandidates = [];

    Object.values(next.rs)
      .flat()
      .forEach((u) => {
        if (u.state === "WRITE_READY") {
          if (u.type === "STORE") {
            if (u.qk === null) writeCandidates.push(u);
          } else {
            writeCandidates.push(u);
          }
        }
      });

    if (writeCandidates.length > 0) {
      // Priority Sort
      writeCandidates.sort((a, b) => {
        // 1. Dependent Count
        let depA = 0,
          depB = 0;
        Object.values(next.rs)
          .flat()
          .forEach((other) => {
            if (other.busy && (other.qj === a.id || other.qk === a.id)) depA++;
            if (other.busy && (other.qj === b.id || other.qk === b.id)) depB++;
          });
        if (depA !== depB) return depB - depA;

        // 2. Ready-to-Exec Count
        let readyA = 0,
          readyB = 0;
        Object.values(next.rs)
          .flat()
          .forEach((other) => {
            if (other.busy) {
              if (other.qj === a.id && other.qk === null) readyA++;
              else if (other.qk === a.id && other.qj === null) readyA++;
              else if (other.qj === a.id && other.qk === a.id) readyA++;

              if (other.qj === b.id && other.qk === null) readyB++;
              else if (other.qk === b.id && other.qj === null) readyB++;
              else if (other.qj === b.id && other.qk === b.id) readyB++;
            }
          });
        if (readyA !== readyB) return readyB - readyA;

        // 3. Static Type
        const priority = { BRANCH: 4, STORE: 3, LOAD: 2, MULT: 1, ADD: 0 };
        return priority[b.type] - priority[a.type];
      });

      const winner = writeCandidates[0];

      // --- PROCESS WINNER ---
      if (winner.type === "STORE") {
        next.memory[winner.address] = winner.vk;
      } else if (winner.type === "BRANCH") {
        const targetAddr = parseInt(winner.address);
        if (winner.result && !isNaN(targetAddr)) {
          next.pc = targetAddr;
          next.iteration++;
        }
        next.branchStall = false;
      } else {
        const result = winner.result;
        const rsId = winner.id;
        Object.values(next.regs).forEach((r) => {
          if (r.qi === rsId) {
            r.val = result;
            r.qi = null;
          }
        });
        Object.values(next.rs)
          .flat()
          .forEach((rs) => {
            if (rs.qj === rsId) {
              rs.vj = result;
              rs.qj = null;
            }
            if (rs.qk === rsId) {
              rs.vk = result;
              rs.qk = null;
            }
          });
      }

      next.instStatus[winner.instIdx].writeRes = next.clock;
      const rsRef = next.rs[winner.type].find((r) => r.id === winner.id);
      rsRef.busy = false;
      rsRef.state = "IDLE";
      rsRef.instIdx = -1;
    }

    // --- PHASE 2: EXECUTE ---
    Object.values(next.rs)
      .flat()
      .forEach((u) => {
        if (!u.busy) return;

        // START EXECUTION?
        if (u.state === "ISSUE" && u.qj === null && u.qk === null) {
          u.state = "EXEC";

          // Record Start Cycle
          next.instStatus[u.instIdx].execStart = next.clock;

          // Addr Calc
          if (u.type === "LOAD" || u.type === "STORE") {
            u.address = (u.vj || 0) + (u.address || 0);
          }

          // Cache Calc
          if (u.type === "LOAD") {
            const addr = u.address;
            const blockIdxRaw = Math.floor(addr / next.config.cache.blockSize);
            const n = next.cache.length;
            const blockIdx = ((blockIdxRaw % n) + n) % n;
            const tag = Math.floor(blockIdxRaw / n);

            if (next.cache[blockIdx]) {
              const block = next.cache[blockIdx];
              const isHit = block.valid && block.tag === tag;

              if (isHit) {
                u.timer = next.config.cache.hitLatency;
                block.history.push(`Hit C${next.clock}`);
              } else {
                u.timer =
                  next.config.cache.hitLatency + next.config.cache.missPenalty;
                next.cache[blockIdx] = {
                  ...block,
                  valid: true,
                  tag,
                  data: `Mem[${Math.floor(addr / 8) * 8}]`,
                  history: [...block.history, `Miss C${next.clock}`],
                };
              }
            }
          }
        }

        if (u.state === "EXEC") {
          if (u.timer > 0) u.timer--;

          if (u.timer === 0) {
            u.state = "WRITE_READY";
            next.instStatus[u.instIdx].execComp = next.clock;

            // Results
            if (u.type === "LOAD")
              u.result =
                next.memory[u.address] !== undefined
                  ? next.memory[u.address]
                  : 0;
            else if (["ADD.D", "ADDI", "DADDI", "DADDIU"].includes(u.op))
              u.result = parseFloat(u.vj) + parseFloat(u.vk);
            else if (["SUB.D", "SUBI", "DSUBI"].includes(u.op))
              u.result = parseFloat(u.vj) - parseFloat(u.vk);
            else if (u.op === "MUL.D")
              u.result = parseFloat(u.vj) * parseFloat(u.vk);
            else if (u.op === "DIV.D")
              u.result = parseFloat(u.vj) / parseFloat(u.vk);
            else if (u.op === "DSLTU") u.result = u.vj < u.vk ? 1 : 0;
          }
        }
      });

    // --- PHASE 3: ISSUE ---
    if (!next.branchStall && next.pc < next.instructions.length) {
      const inst = next.instructions[next.pc];
      const getReg = (rName) => {
        if (rName.match(/^[RF]\d+$/)) return next.regs[rName];
        return { val: parseInt(rName) || 0, qi: null };
      };

      if (inst.type === "BRANCH") {
        const [Op1, Op2, Label] = inst.tokens;
        const r1 = getReg(Op1);
        let r2 = { val: 0, qi: null };
        if (inst.op !== "BNEZ" && inst.op !== "BEQZ") r2 = getReg(Op2);

        if (r1.qi !== null || r2.qi !== null) {
          next.stalledPc = next.pc;
        } else {
          // Execute Immediately (Bypass)
          const val1 = r1.val;
          const val2 = r2.val;
          let taken = false;
          if (inst.op === "BNE") taken = val1 !== val2;
          else if (inst.op === "BEQ") taken = val1 === val2;
          else if (inst.op === "BNEZ") taken = val1 !== 0;
          else if (inst.op === "BEQZ") taken = val1 === 0;

          // NO Entry in Status Table for Branch

          if (taken) {
            let tLabel = inst.op.endsWith("Z") ? Op2 : Label;
            const tAddr = parseInt(tLabel);
            if (!isNaN(tAddr)) {
              next.pc = tAddr;
              next.iteration++;
            } else next.pc++;
          } else {
            next.pc++;
          }
        }
      } else {
        // RS Issue
        let rsType = "ADD";
        if (["MUL.D", "DIV.D"].includes(inst.op)) rsType = "MULT";
        else if (inst.type === "LOAD") rsType = "LOAD";
        else if (inst.type === "STORE") rsType = "STORE";

        const freeUnit = next.rs[rsType].find((u) => !u.busy);

        if (freeUnit) {
          freeUnit.busy = true;
          freeUnit.op = inst.op;
          freeUnit.timer = next.config.latencies[inst.op] || 1;
          freeUnit.state = "ISSUE";

          const statusEntry = {
            id: next.instStatus.length,
            iter: next.iteration,
            text: inst.text,
            j: "",
            k: "",
            issue: next.clock,
            execStart: "",
            execComp: "",
            writeRes: "",
          };
          freeUnit.instIdx = statusEntry.id;

          if (inst.type === "LOAD") {
            const [dest, offsetStr] = inst.tokens;
            const match = offsetStr.match(/(-?\d+)\(([A-Z0-9]+)\)/);
            const offset = parseInt(match?.[1] || offsetStr);
            const baseReg = match?.[2] || "R0";
            const rBase = getReg(baseReg);
            if (rBase.qi) {
              freeUnit.qj = rBase.qi;
              statusEntry.j = rBase.qi;
            } else {
              freeUnit.vj = rBase.val;
              statusEntry.j = rBase.val;
            }
            if (freeUnit.qj === null) freeUnit.address = offset + freeUnit.vj;
            next.regs[dest].qi = freeUnit.id;
          } else if (inst.type === "STORE") {
            const [src, offsetStr] = inst.tokens;
            const rSrc = getReg(src);
            const match = offsetStr.match(/(-?\d+)\(([A-Z0-9]+)\)/);
            const offset = parseInt(match?.[1] || offsetStr);
            const baseReg = match?.[2] || "R0";
            const rBase = getReg(baseReg);
            if (rBase.qi) {
              freeUnit.qj = rBase.qi;
              statusEntry.j = rBase.qi;
            } else {
              freeUnit.vj = rBase.val;
              statusEntry.j = rBase.val;
            }
            if (rSrc.qi) {
              freeUnit.qk = rSrc.qi;
              statusEntry.k = rSrc.qi;
            } else {
              freeUnit.vk = rSrc.val;
              statusEntry.k = rSrc.val;
            }
            freeUnit.address = offset;
            if (freeUnit.qj === null) freeUnit.address += freeUnit.vj;
          } else {
            const [dest, s1, s2] = inst.tokens;
            const r1 = getReg(s1);
            const r2 = getReg(s2);
            if (r1.qi) {
              freeUnit.qj = r1.qi;
              statusEntry.j = r1.qi;
            } else {
              freeUnit.vj = r1.val;
              statusEntry.j = r1.val;
            }
            if (r2.qi) {
              freeUnit.qk = r2.qi;
              statusEntry.k = r2.qi;
            } else {
              freeUnit.vk = r2.val;
              statusEntry.k = r2.val;
            }
            next.regs[dest].qi = freeUnit.id;
          }
          next.instStatus.push(statusEntry);
          next.pc++;
        }
      }
    }
    return next;
  }
  return state;
};

// --- COMPONENTS ---

const CodeTable = ({ instructions, pc, stalledPc }) => (
  <div className="overflow-auto h-32 bg-gray-900 rounded-lg border border-gray-700 shadow-lg custom-scrollbar shrink-0">
    <table className="w-full text-xs text-left border-collapse">
      <thead className="bg-gray-800 text-gray-200 sticky top-0 border-b border-gray-700">
        <tr>
          <th className="p-2 w-10">PC</th>
          <th className="p-2">Source Code</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-800 text-gray-300">
        {instructions.map((inst, idx) => {
          let rowClass = "hover:bg-gray-800/50";
          if (idx === pc) {
            rowClass =
              idx === stalledPc
                ? "bg-orange-900/40 text-orange-200 ring-1 ring-orange-500/50"
                : "bg-blue-900/40 text-white ring-1 ring-blue-500/50";
          }
          return (
            <tr key={idx} className={`${rowClass} transition-colors`}>
              <td className="p-2 text-gray-500 font-mono">{idx}</td>
              <td className="p-2 font-mono flex justify-between">
                {inst.text}
                {idx === stalledPc && (
                  <span className="text-[10px] uppercase font-bold text-orange-500">
                    Wait
                  </span>
                )}
              </td>
            </tr>
          );
        })}
        {instructions.length === 0 && (
          <tr>
            <td colSpan="2" className="p-4 text-center text-gray-600">
              No code loaded
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
);

const StatusTable = ({ data }) => (
  <div className="overflow-auto max-h-60 bg-gray-900 rounded-lg border border-gray-700 shadow-lg custom-scrollbar">
    <table className="w-full text-xs text-left border-collapse">
      <thead className="bg-gray-800 text-gray-200 sticky top-0 border-b border-gray-700">
        <tr>
          <th className="p-3">Iter</th>
          <th className="p-3">Instruction</th>
          <th className="p-3 w-12">j</th>
          <th className="p-3 w-12">k</th>
          <th className="p-3">Issue</th>
          <th className="p-3">Exec Start</th>
          <th className="p-3">Exec Comp</th>
          <th className="p-3">Write Res</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-800 text-gray-300">
        {data.map((row) => (
          <tr
            key={row.id}
            className="odd:bg-gray-900 even:bg-gray-800/50 hover:bg-gray-700/50 transition-colors"
          >
            <td className="p-3 text-gray-500">{row.iter}</td>
            <td className="p-3 font-mono text-blue-400 font-bold">
              {row.text}
            </td>
            <td className="p-3 text-gray-400">{row.j}</td>
            <td className="p-3 text-gray-400">{row.k}</td>
            <td className="p-3 text-center">{row.issue}</td>
            <td className="p-3 text-center">{row.execStart}</td>
            <td className="p-3 text-center">{row.execComp}</td>
            <td className="p-3 text-center text-green-400 font-bold">
              {row.writeRes}
            </td>
          </tr>
        ))}
        {data.length === 0 && (
          <tr>
            <td colSpan="8" className="p-6 text-center text-gray-600">
              No instructions issued yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
);

const RSTable = ({ stations, type }) => (
  <table className="w-full text-[10px] text-left border-collapse">
    <thead className="bg-gray-800 text-gray-400">
      <tr>
        <th className="p-1.5 rounded-l">ID</th>
        <th className="p-1.5">Busy</th>
        <th className="p-1.5">Op</th>
        <th className="p-1.5">Vj</th>
        <th className="p-1.5">Vk</th>
        <th className="p-1.5">Qj</th>
        <th className="p-1.5">Qk</th>
        <th className="p-1.5">Addr</th>
        <th className="p-1.5 rounded-r">Time</th>
      </tr>
    </thead>
    <tbody className="divide-y divide-gray-800">
      {stations.map((u) => (
        <tr
          key={u.id}
          className={`${
            u.busy ? "bg-blue-900/20 text-blue-100" : "text-gray-600"
          }`}
        >
          <td
            className={`p-1.5 font-bold ${
              u.busy ? "text-blue-400" : "text-gray-700"
            }`}
          >
            {u.id}
          </td>
          <td className="p-1.5">{u.busy ? "Yes" : "No"}</td>
          <td className="p-1.5 font-mono">{u.busy ? u.op : ""}</td>
          <td className="p-1.5 text-gray-400">
            {u.busy && u.vj !== null ? u.vj : ""}
          </td>
          <td className="p-1.5 text-gray-400">
            {u.busy && u.vk !== null ? u.vk : ""}
          </td>
          <td className="p-1.5 text-orange-400 font-bold">
            {u.busy ? u.qj : ""}
          </td>
          <td className="p-1.5 text-orange-400 font-bold">
            {u.busy ? u.qk : ""}
          </td>
          <td className="p-1.5 text-orange-300">
            {u.busy && u.address !== null
              ? typeof u.address === "number"
                ? u.address
                : "Calc"
              : ""}
          </td>
          <td className="p-1.5 font-bold">
            {u.busy && u.timer > 0 ? (
              <span className="text-green-400">{u.timer}</span>
            ) : u.busy && u.state === "WRITE_READY" ? (
              <span className="text-green-500 font-extrabold">Finish</span>
            ) : (
              ""
            )}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

const CacheView = ({ cache }) => (
  <div className="grid grid-cols-8 gap-2">
    {cache.map((block) => (
      <div
        key={block.index}
        className={`rounded p-2 text-[10px] flex flex-col items-center border transition-all ${
          block.valid
            ? "bg-green-900/20 border-green-700/50 text-green-100"
            : "bg-gray-800 border-gray-700 text-gray-500"
        }`}
      >
        <div className="font-bold mb-1 opacity-50">Idx: {block.index}</div>
        {block.valid ? (
          <>
            <div className="text-green-400 font-bold">Tag: {block.tag}</div>
            <div
              className="text-xs truncate w-full text-center bg-gray-900/50 rounded mt-1 px-1 py-0.5"
              title={block.data}
            >
              {block.data}
            </div>
            <div className="mt-1 text-green-500/50 text-[9px]">
              {block.history.length} Accesses
            </div>
          </>
        ) : (
          <div className="italic py-2 opacity-30">Invalid</div>
        )}
      </div>
    ))}
  </div>
);

const ConfigScreen = ({ onStart, initialConfig, initialCode }) => {
  const [config, setConfig] = useState(initialConfig || DEFAULT_CONFIG);
  const [code, setCode] = useState(initialCode || DEFAULT_CODE);

  // Helper to handle input updates robustly
  const update = (path, val) => {
    const c = JSON.parse(JSON.stringify(config));
    let ref = c;
    const parts = path.split(".");
    while (parts.length > 1) ref = ref[parts.shift()];

    // Handle empty strings for controlled inputs (prevents NaN lock)
    if (val === "") {
      ref[parts[0]] = "";
    } else {
      ref[parts[0]] = parseInt(val) || 0;
    }
    setConfig(c);
  };

  // Helper to update a group of latencies at once
  const updateGroupLatency = (ops, val) => {
    const c = JSON.parse(JSON.stringify(config));
    const newVal = val === "" ? "" : parseInt(val) || 0;
    ops.forEach((op) => (c.latencies[op] = newVal));
    setConfig(c);
  };

  return (
    <div className="min-h-screen bg-gray-950 p-8 font-sans text-gray-200">
      <div className="max-w-5xl mx-auto bg-gray-900 rounded-xl shadow-2xl border border-gray-800 overflow-hidden">
        <div className="bg-gray-800 p-6 flex justify-between items-center border-b border-gray-700">
          <div>
            <h1 className="text-2xl font-bold text-blue-400">
              CSEN 702: Tomasulo Simulator
            </h1>
            <p className="text-gray-400 text-sm">
              Configure your architecture environment
            </p>
          </div>
          <Cpu size={40} className="text-blue-500 opacity-80" />
        </div>

        <div className="p-6 grid grid-cols-2 gap-8">
          {/* Left: Code */}
          <div>
            <h3 className="font-bold text-gray-300 mb-3 flex items-center gap-2 text-sm uppercase tracking-wider">
              <Terminal size={16} className="text-blue-400" /> Assembly Code
            </h3>
            <textarea
              className="w-full h-96 p-4 font-mono text-sm bg-gray-950 text-green-400 rounded-lg border border-gray-700 focus:ring-2 ring-blue-500/50 outline-none resize-none"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck="false"
            />
            <div className="mt-3 text-xs text-gray-500">
              Supported: L.D, S.D, ADD.D, MUL.D, DIV.D, BNE, DADDI, etc.
            </div>
          </div>

          {/* Right: Settings */}
          <div className="space-y-6 overflow-y-auto h-96 pr-2 custom-scrollbar">
            {/* Latencies Grouped */}
            <div className="bg-gray-800/50 p-4 rounded-lg border border-gray-700">
              <h4 className="font-bold text-gray-400 text-xs mb-3 uppercase border-b border-gray-700 pb-2">
                Latencies (Cycles)
              </h4>
              <div className="space-y-3">
                <label className="text-xs font-semibold text-gray-500 block">
                  Add / Sub Unit (FP & Int)
                  <input
                    type="number"
                    value={config.latencies["ADD.D"]}
                    onChange={(e) =>
                      updateGroupLatency(
                        [
                          "ADD.D",
                          "ADD.S",
                          "SUB.D",
                          "SUB.S",
                          "ADDI",
                          "SUBI",
                          "DADDI",
                          "DSUBI",
                          "DADDIU",
                          "DSLTU",
                        ],
                        e.target.value
                      )
                    }
                    className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 focus:border-blue-500 outline-none"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-semibold text-gray-500 block">
                    Multiplication
                    <input
                      type="number"
                      value={config.latencies["MUL.D"]}
                      onChange={(e) =>
                        updateGroupLatency(["MUL.D", "MUL.S"], e.target.value)
                      }
                      className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 focus:border-blue-500 outline-none"
                    />
                  </label>
                  <label className="text-xs font-semibold text-gray-500 block">
                    Division
                    <input
                      type="number"
                      value={config.latencies["DIV.D"]}
                      onChange={(e) =>
                        updateGroupLatency(["DIV.D", "DIV.S"], e.target.value)
                      }
                      className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 focus:border-blue-500 outline-none"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-semibold text-gray-500 block">
                    Load
                    <input
                      type="number"
                      value={config.latencies["L.D"]}
                      onChange={(e) =>
                        updateGroupLatency(
                          ["L.D", "L.S", "LW", "LD"],
                          e.target.value
                        )
                      }
                      className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 focus:border-blue-500 outline-none"
                    />
                  </label>
                  <label className="text-xs font-semibold text-gray-500 block">
                    Store
                    <input
                      type="number"
                      value={config.latencies["S.D"]}
                      onChange={(e) =>
                        updateGroupLatency(
                          ["S.D", "S.S", "SW", "SD"],
                          e.target.value
                        )
                      }
                      className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 focus:border-blue-500 outline-none"
                    />
                  </label>
                </div>
              </div>
            </div>

            {/* RS Sizes */}
            <div className="bg-gray-800/50 p-4 rounded-lg border border-gray-700">
              <h4 className="font-bold text-gray-400 text-xs mb-3 uppercase border-b border-gray-700 pb-2">
                Buffer Sizes
              </h4>
              <div className="grid grid-cols-4 gap-3">
                {["ADD", "MULT", "LOAD", "STORE"].map((type) => (
                  <label
                    key={type}
                    className="text-xs font-semibold text-gray-500 block"
                  >
                    {type}
                    <input
                      type="number"
                      value={config.rsSize[type]}
                      onChange={(e) => update(`rsSize.${type}`, e.target.value)}
                      className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 focus:border-blue-500 outline-none"
                    />
                  </label>
                ))}
              </div>
            </div>

            {/* Cache Config */}
            <div className="bg-blue-900/10 p-4 rounded-lg border border-blue-900/30">
              <h4 className="font-bold text-blue-400 text-xs mb-3 uppercase border-b border-blue-900/30 pb-2 flex items-center gap-2">
                <MemoryStick size={14} /> Cache Config
              </h4>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-semibold text-gray-500 block">
                  Size (Bytes)
                  <input
                    type="number"
                    value={config.cache.size}
                    onChange={(e) => update(`cache.size`, e.target.value)}
                    className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 focus:border-blue-500 outline-none"
                  />
                </label>
                <label className="text-xs font-semibold text-gray-500 block">
                  Block Size (Bytes)
                  <input
                    type="number"
                    value={config.cache.blockSize}
                    onChange={(e) => update(`cache.blockSize`, e.target.value)}
                    className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 focus:border-blue-500 outline-none"
                  />
                </label>
                <label className="text-xs font-semibold text-gray-500 block">
                  Hit Time
                  <input
                    type="number"
                    value={config.cache.hitLatency}
                    onChange={(e) => update(`cache.hitLatency`, e.target.value)}
                    className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 focus:border-blue-500 outline-none"
                  />
                </label>
                <label className="text-xs font-semibold text-gray-500 block">
                  Miss Penalty
                  <input
                    type="number"
                    value={config.cache.missPenalty}
                    onChange={(e) =>
                      update(`cache.missPenalty`, e.target.value)
                    }
                    className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 focus:border-blue-500 outline-none"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
        <div className="p-6 bg-gray-800 border-t border-gray-700 flex justify-end">
          <button
            onClick={() => onStart(config, code)}
            className="bg-blue-600 hover:bg-blue-500 text-white px-8 py-3 rounded-lg font-bold shadow-lg flex items-center gap-2 transition-colors"
          >
            Launch Simulator <ArrowRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default function TomasuloApp() {
  const [config, setConfig] = useState(null);
  const [code, setCode] = useState(DEFAULT_CODE);
  const [state, dispatch] = useReducer(reducer, null);

  if (!state)
    return (
      <ConfigScreen
        initialConfig={config}
        initialCode={code}
        onStart={(c, cd) => {
          setConfig(c);
          setCode(cd);
          dispatch({ type: "RESET", config: c, code: cd });
        }}
      />
    );

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-300 font-sans text-xs overflow-hidden">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-2 flex justify-between items-center shadow-lg z-10">
        <div className="flex items-center gap-4">
          <div className="bg-blue-900/50 text-blue-200 px-3 py-1 rounded border border-blue-800 font-bold flex items-center gap-2">
            <Play size={12} className="fill-current" /> Cycle {state.clock}
          </div>
          <div className="h-6 w-px bg-gray-800"></div>
          <button
            onClick={() => dispatch({ type: "STEP" })}
            className="flex items-center gap-1 bg-green-700 hover:bg-green-600 text-white px-4 py-1.5 rounded shadow transition-colors font-bold"
          >
            <SkipForward size={14} /> Step
          </button>
          <button
            onClick={() => dispatch({ type: "RESET", config, code })}
            className="flex items-center gap-1 bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-1.5 rounded shadow border border-gray-700 transition-colors"
          >
            <RotateCcw size={14} /> Reset
          </button>
          <button
            onClick={() => dispatch({ type: "EXIT" })}
            className="flex items-center gap-1 bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-1.5 rounded shadow border border-gray-700 transition-colors"
          >
            <Settings size={14} /> Config
          </button>
        </div>
        <div className="text-gray-500 font-mono">PC: {state.pc}</div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* LEFT COLUMN: STATUS & CACHE */}
        <div className="flex-[3] flex flex-col p-2 gap-2 overflow-y-auto custom-scrollbar">
          {/* Program Code Table */}
          <div className="bg-gray-900 p-3 rounded-lg shadow border border-gray-800 shrink-0">
            <h3 className="font-bold text-gray-400 mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider">
              <Code size={14} /> Program Code
            </h3>
            <CodeTable
              instructions={state.instructions}
              pc={state.pc}
              stalledPc={state.stalledPc}
            />
          </div>

          {/* Instruction Status */}
          <div className="bg-gray-900 p-3 rounded-lg shadow border border-gray-800">
            <h3 className="font-bold text-gray-400 mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider">
              <Layers size={14} /> Instruction Status
            </h3>
            <StatusTable data={state.instStatus} />
          </div>

          {/* RS Tables */}
          <div className="grid grid-cols-2 gap-2">
            {["ADD", "MULT", "LOAD", "STORE"].map((type) => (
              <div
                key={type}
                className="bg-gray-900 p-2 rounded-lg shadow border border-gray-800"
              >
                <h4 className="font-bold text-gray-500 mb-2 text-[10px] uppercase tracking-wider pl-1">
                  {type} Buffer
                </h4>
                <RSTable stations={state.rs[type]} type={type} />
              </div>
            ))}
          </div>

          {/* Cache Viz */}
          <div className="bg-gray-900 p-3 rounded-lg shadow border border-gray-800">
            <h3 className="font-bold text-gray-400 mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider">
              <MemoryStick size={14} /> Data Cache (Direct Mapped)
            </h3>
            <CacheView cache={state.cache} />
          </div>
        </div>

        {/* RIGHT COLUMN: REGISTERS & MEMORY */}
        <div className="flex-1 min-w-[300px] bg-gray-900 border-l border-gray-800 p-2 flex flex-col gap-2 h-full overflow-hidden">
          {/* FP Registers */}
          <div className="bg-gray-800/50 p-2 rounded border border-gray-700 flex-1 flex flex-col min-h-0">
            <h3 className="font-bold text-gray-400 mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider sticky top-0 bg-gray-800/90 p-1">
              <Database size={14} /> Registers (FP)
            </h3>
            <div className="grid grid-cols-2 gap-1 overflow-y-auto custom-scrollbar flex-1">
              {Object.entries(state.regs)
                .filter(([k]) => k.startsWith("F"))
                .map(([k, v]) => (
                  <div
                    key={k}
                    className={`flex justify-between p-1.5 rounded border text-[10px] ${
                      v.qi
                        ? "bg-orange-900/30 border-orange-800/50"
                        : "bg-gray-900 border-gray-700"
                    }`}
                  >
                    <span className="font-bold text-gray-500">{k}</span>
                    <span
                      className={
                        v.qi ? "text-orange-400 font-bold" : "text-blue-400"
                      }
                    >
                      {v.qi || v.val.toFixed(1)}
                    </span>
                  </div>
                ))}
            </div>
          </div>

          {/* Int Registers */}
          <div className="bg-gray-800/50 p-2 rounded border border-gray-700 flex-1 flex flex-col min-h-0">
            <h3 className="font-bold text-gray-400 mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider sticky top-0 bg-gray-800/90 p-1">
              <Cpu size={14} /> Registers (Int)
            </h3>
            <div className="grid grid-cols-2 gap-1 overflow-y-auto custom-scrollbar flex-1">
              {Object.entries(state.regs)
                .filter(([k]) => k.startsWith("R"))
                .map(([k, v]) => (
                  <div
                    key={k}
                    className={`flex justify-between p-1.5 rounded border text-[10px] ${
                      v.qi
                        ? "bg-orange-900/30 border-orange-800/50"
                        : "bg-gray-900 border-gray-700"
                    }`}
                  >
                    <span className="font-bold text-gray-500">{k}</span>
                    <span
                      className={
                        v.qi ? "text-orange-400 font-bold" : "text-blue-400"
                      }
                    >
                      {v.qi || v.val}
                    </span>
                  </div>
                ))}
            </div>
          </div>

          {/* Memory - Fixed Height, Scrollable */}
          <div className="bg-gray-800/50 p-2 rounded border border-gray-700 h-48 flex flex-col shrink-0">
            <h3 className="font-bold text-gray-400 mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider">
              <Save size={14} /> Memory
            </h3>
            <div className="space-y-1 font-mono text-[10px] overflow-y-auto custom-scrollbar flex-1">
              {Object.entries(state.memory).length === 0 ? (
                <div className="text-gray-600 italic p-2 text-center">
                  Memory Empty
                </div>
              ) : (
                Object.entries(state.memory).map(([addr, val]) => (
                  <div
                    key={addr}
                    className="flex flex-col border-b border-gray-700 py-2 px-1 gap-1"
                  >
                    <div className="flex justify-between text-gray-400">
                      <span>Addr: {addr}</span>
                      <span className="font-bold text-green-400">
                        {val} (Dec)
                      </span>
                    </div>
                    <div className="text-xs text-blue-500/80 tracking-widest break-all">
                      {toBinary32(val)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
