import React, { useState, useReducer, useEffect, useRef } from "react";
import {
  Play,
  SkipForward,
  RotateCcw,
  Settings,
  Cpu,
  Database,
  Layers,
  MemoryStick,
  AlertCircle,
  Edit3,
  GitBranch,
  Archive,
} from "lucide-react";

// --- UTILITIES & PARSING ---

const PARSER_REGEX = {
  MEM: /^([A-Z\.]+)\s+([RF]\d+)\s*,\s*(-?\d+)\(([RF]\d+)\)$/i,
  ALU: /^([A-Z\.]+)\s+([RF]\d+)\s*,\s*([RF]\d+)\s*,\s*(?:#)?([RF0-9\.-]+)$/i,
  BRANCH: /^(BNE|BEQ)\s+([RF]\d+)\s*,\s*([RF0-9]+)\s*,\s*([A-Z0-9]+)$/i,
  BRANCH_Z: /^(BNEZ|BEQZ)\s+([RF]\d+)\s*,\s*([A-Z0-9]+)$/i, // Handle BNEZ R1, LOOP
  LABEL: /^([A-Z0-9]+):?/i,
};

const parseInstruction = (line, index) => {
  const cleanLine = line.trim().toUpperCase();
  if (!cleanLine || cleanLine.startsWith(";")) return null;

  let label = null;
  let instruction = cleanLine;

  const labelMatch = cleanLine.match(/^([A-Z0-9]+):/);
  if (labelMatch) {
    label = labelMatch[1];
    instruction = cleanLine.substring(labelMatch[0].length).trim();
    if (!instruction)
      return { type: "LABEL", label, id: index, text: cleanLine };
  } else if (cleanLine.match(/^[A-Z0-9]+$/)) {
    return { type: "LABEL", label: cleanLine, id: index, text: cleanLine };
  }

  let match;
  if ((match = instruction.match(PARSER_REGEX.MEM))) {
    return {
      id: index,
      label,
      text: instruction,
      type: "MEM",
      op: match[1],
      dest: match[2],
      imm: parseInt(match[3]),
      rs: match[4],
    };
  } else if ((match = instruction.match(PARSER_REGEX.BRANCH))) {
    return {
      id: index,
      label,
      text: instruction,
      type: "BRANCH",
      op: match[1],
      rs: match[2],
      rt: match[3],
      target: match[4],
    };
  } else if ((match = instruction.match(PARSER_REGEX.BRANCH_Z))) {
    return {
      id: index,
      label,
      text: instruction,
      type: "BRANCH",
      op: match[1],
      rs: match[2],
      rt: null,
      target: match[3], // RT is null for Zero check
    };
  } else if ((match = instruction.match(PARSER_REGEX.ALU))) {
    return {
      id: index,
      label,
      text: instruction,
      type: "ALU",
      op: match[1],
      dest: match[2],
      src1: match[3],
      src2: match[4],
    };
  }

  return { id: index, label, text: instruction, type: "UNKNOWN" };
};

const STORE_OPS = ["S.D", "S.S", "SW", "SD"];
const LOAD_OPS = ["L.D", "L.S", "LW", "LD"];
const BRANCH_OPS = ["BNE", "BEQ", "BNEZ", "BEQZ"];

// --- INITIAL CONFIGURATION ---

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
    "MUL.D": 10,
    "MUL.S": 10,
    "DIV.D": 40,
    "DIV.S": 40,
    BNE: 1,
    BEQ: 1,
    BNEZ: 1,
  },
  cache: {
    enabled: true,
    size: 64,
    blockSize: 8,
    hitLatency: 1,
    missPenalty: 10,
  },
  memorySize: 128,
};

const DEFAULT_CODE = `LOOP: L.D   F0, 0(R1)
      MUL.D F4, F0, F2
      S.D   F4, 0(R1)
      SUBI  R1, R1, 8
      BNEZ  R1, LOOP`;

// --- SIMULATOR LOGIC ---

const generateInitialState = (config, codeText) => {
  const lines = codeText.split("\n");
  const instructions = lines
    .map((l, i) => parseInstruction(l, i))
    .filter((l) => l);

  const labels = {};
  instructions.forEach((inst, idx) => {
    if (inst.label) labels[inst.label] = idx;
  });

  const regs = {};
  for (let i = 0; i < 32; i++) regs[`R${i}`] = { val: 0, qi: null };
  for (let i = 0; i < 32; i++) regs[`F${i}`] = { val: 0.0, qi: null };

  // Pre-load specific values for the loop trace
  regs["R1"].val = 32; // Loop starts at address 32, decrements by 8
  regs["F2"].val = 0.5; // Multiplier

  // Init Memory with some data at the target addresses
  const memoryValues = {
    32: 100.0,
    24: 200.0,
    16: 300.0,
    8: 400.0,
  };

  const numBlocks = config.cache.size / config.cache.blockSize;
  const cacheBlocks = Array.from({ length: numBlocks }, () => ({
    valid: false,
    tag: null,
    data: null,
    lastAccess: 0,
  }));

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
    }));
  });

  return {
    clock: 0,
    pc: 0,
    instructions,
    labels,
    config,
    rs,
    regs,
    memoryValues,
    cache: cacheBlocks,
    log: ["Classic Tomasulo Initialized."],
    branchStall: false,
  };
};

const reducer = (state, action) => {
  if (action.type === "RESET")
    return generateInitialState(action.config, action.code);

  if (action.type === "STEP") {
    let next = JSON.parse(JSON.stringify(state));
    next.clock++;
    const { config, rs, regs, cache } = next;
    const log = [];

    const addToLog = (msg) => log.unshift(`C${next.clock}: ${msg}`);

    // --- HELPER: CDB BROADCAST ---
    const broadcast = (rsId, value) => {
      // 1. Update Register File
      Object.keys(next.regs).forEach((regName) => {
        if (next.regs[regName].qi === rsId) {
          next.regs[regName].val = value;
          next.regs[regName].qi = null;
        }
      });

      // 2. Update Reservation Stations (Qj, Qk)
      Object.values(next.rs)
        .flat()
        .forEach((unit) => {
          if (unit.busy) {
            if (unit.qj === rsId) {
              unit.vj = value;
              unit.qj = null;
            }
            if (unit.qk === rsId) {
              unit.vk = value;
              unit.qk = null;
            }
          }
        });

      addToLog(`${rsId} broadcast ${value}`);
    };

    // --- STAGE 1: EXECUTE & WRITE RESULT ---

    Object.keys(rs).forEach((type) => {
      rs[type].forEach((unit) => {
        if (!unit.busy) return;

        // Check Operands Readiness
        const hasOperands = unit.qj === null && unit.qk === null;

        if (unit.state === "IDLE" && hasOperands) {
          unit.state = "EXECUTING";

          if (type === "LOAD" || type === "STORE") {
            // Address Calc: Base(Vj) + Offset(Address stored in Issue)
            // Note: In Issue below, we store Imm in 'address' field initially.
            unit.address = (unit.vj || 0) + (unit.address || 0);
          }
        }

        if (unit.state === "EXECUTING") {
          // Handle Cache Latency for Loads
          if (type === "LOAD" && unit.timer === 0) {
            const addr = unit.address;
            const blockIdx =
              Math.floor(addr / config.cache.blockSize) % cache.length;
            const tag = Math.floor(addr / config.cache.blockSize);
            const isHit = cache[blockIdx].valid && cache[blockIdx].tag === tag;

            if (isHit) {
              unit.timer = config.cache.hitLatency;
              addToLog(`Cache HIT at ${addr}`);
            } else {
              unit.timer = config.cache.hitLatency + config.cache.missPenalty;
              addToLog(`Cache MISS at ${addr}`);
              cache[blockIdx] = { valid: true, tag, data: "Block" };
            }
          }

          if (unit.timer > 0) unit.timer--;

          if (unit.timer === 0) {
            let result = 0;

            // ALU Logic
            if (type === "LOAD") result = next.memoryValues[unit.address] || 0;
            else if (["ADD.D", "ADD.S", "ADDI", "DADDI"].includes(unit.op))
              result = unit.vj + unit.vk;
            else if (["SUB.D", "SUB.S", "SUBI", "DSUBI"].includes(unit.op))
              result = unit.vj - unit.vk;
            else if (["MUL.D", "MUL.S"].includes(unit.op))
              result = unit.vj * unit.vk;
            else if (["DIV.D", "DIV.S"].includes(unit.op))
              result = unit.vj / unit.vk;
            else if (BRANCH_OPS.includes(unit.op)) {
              // Branch evaluation
              if (unit.op === "BNE") result = unit.vj !== unit.vk ? 1 : 0;
              if (unit.op === "BEQ") result = unit.vj === unit.vk ? 1 : 0;
              if (unit.op === "BNEZ") result = unit.vj !== 0 ? 1 : 0; // Compare against 0
            }

            unit.computedResult = result;
            unit.state = "WRITE";
          }
        }

        // Write Result Stage
        if (unit.state === "WRITE") {
          if (type === "STORE") {
            // Store Buffer waits for Value (Vk/Qk)
            if (unit.qk === null) {
              const addr = unit.address;
              const val = unit.vk;
              next.memoryValues[addr] = val;
              addToLog(`Store ${val} to Mem[${addr}]`);

              const blockIdx =
                Math.floor(addr / config.cache.blockSize) % cache.length;
              const tag = Math.floor(addr / config.cache.blockSize);
              if (cache[blockIdx].valid && cache[blockIdx].tag === tag)
                cache[blockIdx].valid = false;

              unit.busy = false;
              unit.state = "IDLE";
            }
          } else if (BRANCH_OPS.includes(unit.op)) {
            // Branch Resolution
            const taken = unit.computedResult === 1;
            if (taken) {
              // Unit Address holds Label Name (string) from Issue
              if (next.labels[unit.address] !== undefined) {
                next.pc = next.labels[unit.address];
                addToLog(`Branch Taken -> Jump to ${unit.address}`);
              } else {
                addToLog(`Branch Error: Label ${unit.address} not found`);
              }
            } else {
              addToLog(`Branch Not Taken -> Continue`);
            }

            next.branchStall = false; // Unstall Fetch
            unit.busy = false;
            unit.state = "IDLE";
          } else {
            broadcast(unit.id, unit.computedResult);
            unit.busy = false;
            unit.state = "IDLE";
          }
        }
      });
    });

    // --- STAGE 2: ISSUE ---
    if (!next.branchStall && next.pc < next.instructions.length) {
      const inst = next.instructions[next.pc];

      if (inst.type === "LABEL") {
        next.pc++;
      } else {
        let type = "";
        if (LOAD_OPS.includes(inst.op)) type = "LOAD";
        else if (STORE_OPS.includes(inst.op)) type = "STORE";
        else if (["MUL.D", "DIV.D", "MUL.S", "DIV.S"].includes(inst.op))
          type = "MULT";
        else type = "ADD";

        const freeIdx = next.rs[type].findIndex((u) => !u.busy);

        if (freeIdx !== -1) {
          const rsUnit = next.rs[type][freeIdx];
          rsUnit.busy = true;
          rsUnit.op = inst.op;
          rsUnit.timer = config.latencies[inst.op] || 1;
          rsUnit.state = "IDLE";

          const getReg = (regName) => {
            if (!isNaN(regName)) return { val: parseFloat(regName), qi: null };
            const r = next.regs[regName];
            return { val: r.val, qi: r.qi };
          };

          if (type === "LOAD") {
            const base = getReg(inst.rs);
            rsUnit.vj = base.val;
            rsUnit.qj = base.qi;
            rsUnit.address = inst.imm;
            rsUnit.vk = null;
            rsUnit.qk = null;
            if (inst.dest) next.regs[inst.dest].qi = rsUnit.id;
          } else if (type === "STORE") {
            const base = getReg(inst.rs);
            rsUnit.vj = base.val;
            rsUnit.qj = base.qi;
            const src = getReg(inst.dest);
            rsUnit.vk = src.val;
            rsUnit.qk = src.qi;
            rsUnit.address = inst.imm;
          } else if (BRANCH_OPS.includes(inst.op)) {
            const src1 = getReg(inst.rs);
            rsUnit.vj = src1.val;
            rsUnit.qj = src1.qi;

            // Check if 2 operand branch (BNE) or 1 (BNEZ)
            if (inst.rt) {
              const src2 = getReg(inst.rt);
              rsUnit.vk = src2.val;
              rsUnit.qk = src2.qi;
            } else {
              rsUnit.vk = 0;
              rsUnit.qk = null; // Compare vs 0
            }

            rsUnit.address = inst.target; // Store Target Label
            next.branchStall = true; // Stall Fetch
          } else {
            const src1 = getReg(inst.src1);
            const src2 = getReg(inst.src2);
            rsUnit.vj = src1.val;
            rsUnit.qj = src1.qi;
            rsUnit.vk = src2.val;
            rsUnit.qk = src2.qi;
            if (inst.dest) next.regs[inst.dest].qi = rsUnit.id;
          }

          next.pc++;
          addToLog(`Issued ${inst.text} to ${rsUnit.id}`);
        } else {
          addToLog(`Stall: No RS for ${inst.op}`);
        }
      }
    }

    next.log = [...log, ...next.log].slice(0, 50);
    return next;
  }
  return state;
};

// --- UI COMPONENTS ---

const Section = ({ title, children, icon: Icon, className = "" }) => (
  <div
    className={`bg-gray-800 rounded-xl overflow-hidden shadow-lg border border-gray-700 flex flex-col ${className}`}
  >
    <div className="bg-gray-700/50 px-3 py-2 border-b border-gray-700 flex items-center gap-2">
      {Icon && <Icon size={14} className="text-blue-400" />}
      <h3 className="font-semibold text-gray-200 text-xs tracking-wider uppercase">
        {title}
      </h3>
    </div>
    <div className="p-2 overflow-auto flex-1 custom-scrollbar">{children}</div>
  </div>
);

const RSTable = ({ stations, type }) => (
  <table className="w-full text-xs text-left border-collapse">
    <thead className="bg-gray-900/50 text-gray-500">
      <tr>
        <th className="p-1">ID</th>
        <th className="p-1">Busy</th>
        <th className="p-1">Op</th>
        <th className="p-1">Vj</th>
        <th className="p-1">Vk</th>
        <th className="p-1">Qj</th>
        <th className="p-1">Qk</th>
        {type === "LOAD" || type === "STORE" ? (
          <th className="p-1">Addr</th>
        ) : null}
        <th className="p-1">Time</th>
      </tr>
    </thead>
    <tbody className="divide-y divide-gray-800">
      {stations.map((u) => (
        <tr key={u.id} className={u.busy ? "bg-gray-800/80" : "opacity-30"}>
          <td className="p-1 font-medium text-blue-300">{u.id}</td>
          <td className="p-1 text-gray-400">{u.busy ? "Yes" : "No"}</td>
          <td className="p-1 text-white">{u.busy ? u.op : ""}</td>
          <td className="p-1 font-mono text-gray-400">
            {u.busy && u.vj !== null ? u.vj : ""}
          </td>
          <td className="p-1 font-mono text-gray-400">
            {u.busy && u.vk !== null ? u.vk : ""}
          </td>
          <td className="p-1 text-yellow-500">{u.busy ? u.qj : ""}</td>
          <td className="p-1 text-yellow-500">{u.busy ? u.qk : ""}</td>
          {type === "LOAD" || type === "STORE" ? (
            <td className="p-1 text-orange-300">
              {u.busy
                ? typeof u.address === "number"
                  ? u.address
                  : u.busy
                  ? "Calc"
                  : ""
                : ""}
            </td>
          ) : null}
          <td className="p-1 font-bold text-green-400">
            {u.busy && u.timer > 0 ? u.timer : ""}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

const RegisterFile = ({ regs }) => (
  <div className="grid grid-cols-4 gap-1">
    {Object.keys(regs).map((k) => (
      <div
        key={k}
        className={`p-1 rounded text-[10px] border ${
          regs[k].qi
            ? "border-yellow-600 bg-yellow-900/20"
            : "border-gray-700 bg-gray-800"
        }`}
      >
        <div className="flex justify-between">
          <span className="font-bold text-gray-400">{k}</span>
          {regs[k].qi && <span className="text-yellow-400">{regs[k].qi}</span>}
        </div>
        <div className="truncate text-gray-200">{regs[k].val}</div>
      </div>
    ))}
  </div>
);

const ConfigScreen = ({ onStart }) => {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const updateVal = (path, val) => {
    const keys = path.split(".");
    setConfig((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      let ref = next;
      for (let i = 0; i < keys.length - 1; i++) ref = ref[keys[i]];
      ref[keys[keys.length - 1]] = parseInt(val);
      return next;
    });
  };
  return (
    <div className="p-8 max-w-2xl mx-auto bg-gray-900 text-gray-100 rounded-xl mt-10 shadow-2xl">
      <h1 className="text-2xl font-bold mb-6 text-blue-400">
        Classic Tomasulo Config
      </h1>
      <div className="space-y-6">
        <div>
          <h3 className="font-bold text-gray-400 mb-2 uppercase text-xs">
            Buffer Sizes
          </h3>
          <div className="grid grid-cols-4 gap-4">
            {["ADD", "MULT", "LOAD", "STORE"].map((t) => (
              <label key={t} className="text-xs">
                {t} Stations
                <input
                  type="number"
                  value={config.rsSize[t]}
                  onChange={(e) => updateVal(`rsSize.${t}`, e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded p-1 mt-1"
                />
              </label>
            ))}
          </div>
        </div>
        <div>
          <h3 className="font-bold text-gray-400 mb-2 uppercase text-xs">
            Latencies
          </h3>
          <div className="grid grid-cols-4 gap-4">
            <label className="text-xs">
              Add/Sub
              <input
                type="number"
                defaultValue={2}
                className="w-full bg-gray-800 border border-gray-700 rounded p-1"
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  setConfig((p) => {
                    const n = { ...p };
                    ["ADD.D", "SUB.D", "ADDI"].forEach(
                      (k) => (n.latencies[k] = v)
                    );
                    return n;
                  });
                }}
              />
            </label>
            <label className="text-xs">
              Mult
              <input
                type="number"
                value={config.latencies["MUL.D"]}
                onChange={(e) => updateVal(`latencies.MUL.D`, e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-1"
              />
            </label>
            <label className="text-xs">
              Div
              <input
                type="number"
                value={config.latencies["DIV.D"]}
                onChange={(e) => updateVal(`latencies.DIV.D`, e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-1"
              />
            </label>
            <label className="text-xs">
              Load/Store
              <input
                type="number"
                value={config.latencies["L.D"]}
                onChange={(e) => updateVal(`latencies.L.D`, e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-1"
              />
            </label>
          </div>
        </div>
      </div>
      <button
        onClick={() => onStart(config)}
        className="mt-8 w-full py-3 bg-blue-600 hover:bg-blue-500 rounded font-bold"
      >
        Initialize
      </button>
    </div>
  );
};

export default function TomasuloSimulator() {
  const [config, setConfig] = useState(null);
  const [code, setCode] = useState(DEFAULT_CODE);
  const [state, dispatch] = useReducer(reducer, null);
  const [activeTab, setActiveTab] = useState("FP");

  if (!config || !state)
    return (
      <ConfigScreen
        onStart={(c) => {
          setConfig(c);
          dispatch({ type: "RESET", config: c, code });
        }}
      />
    );

  return (
    <div className="h-screen bg-gray-950 text-gray-100 flex flex-col font-sans text-xs">
      {/* HEADER */}
      <div className="bg-gray-900 border-b border-gray-800 p-2 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h1 className="font-bold text-lg text-blue-400 ml-2">
            Classic Tomasulo
          </h1>
          <div className="flex gap-2">
            <button
              onClick={() => dispatch({ type: "STEP" })}
              className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded font-bold flex items-center gap-2"
            >
              <SkipForward size={14} /> Step
            </button>
            <button
              onClick={() => dispatch({ type: "RESET", config, code })}
              className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded flex items-center gap-2"
            >
              <RotateCcw size={14} /> Reset
            </button>
            <button
              onClick={() => setConfig(null)}
              className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded flex items-center gap-2"
            >
              <Settings size={14} /> Config
            </button>
          </div>
        </div>
        <div className="mr-4 text-xl font-mono font-bold">
          Cycle: {state.clock}
        </div>
      </div>

      {/* BODY */}
      <div className="flex-1 flex overflow-hidden p-2 gap-2">
        {/* COL 1: Code & Regs */}
        <div className="flex flex-col gap-2 w-1/4 min-w-[250px]">
          <Section title="Instruction Queue" icon={Layers} className="flex-[2]">
            {state.instructions.map((inst, i) => (
              <div
                key={i}
                className={`flex px-1 ${
                  i === state.pc
                    ? "bg-blue-900/50 text-white border border-blue-500"
                    : "text-gray-500"
                }`}
              >
                <span className="w-6">{i}</span>
                <span>{inst.text}</span>
                {i === state.pc && (
                  <span className="ml-auto text-blue-300 font-bold">
                    <GitBranch size={10} />
                  </span>
                )}
              </div>
            ))}
          </Section>
          <Section title="Register File" icon={Database} className="flex-[3]">
            <div className="flex gap-2 mb-2">
              <button
                onClick={() => setActiveTab("FP")}
                className={`px-2 py-1 rounded ${
                  activeTab === "FP" ? "bg-blue-600" : "bg-gray-800"
                }`}
              >
                FP
              </button>
              <button
                onClick={() => setActiveTab("R")}
                className={`px-2 py-1 rounded ${
                  activeTab === "R" ? "bg-blue-600" : "bg-gray-800"
                }`}
              >
                INT
              </button>
            </div>
            <RegisterFile
              regs={Object.fromEntries(
                Object.entries(state.regs).filter(([k]) =>
                  k.startsWith(activeTab === "FP" ? "F" : "R")
                )
              )}
            />
          </Section>
        </div>

        {/* COL 2: Reservation Stations */}
        <div className="flex flex-col gap-2 w-2/4 min-w-[400px]">
          <Section
            title="Adder RS (Add/Sub/Branch)"
            icon={Cpu}
            className="flex-1"
          >
            <RSTable stations={state.rs.ADD} type="ADD" />
          </Section>
          <Section
            title="Multiplier RS (Mult/Div)"
            icon={Cpu}
            className="flex-1"
          >
            <RSTable stations={state.rs.MULT} type="MULT" />
          </Section>
          <Section title="Load Buffers" icon={MemoryStick} className="flex-1">
            <RSTable stations={state.rs.LOAD} type="LOAD" />
          </Section>
          <Section title="Store Buffers" icon={Archive} className="flex-1">
            <RSTable stations={state.rs.STORE} type="STORE" />
          </Section>
        </div>

        {/* COL 3: Memory & Log */}
        <div className="flex flex-col gap-2 w-1/4 min-w-[200px]">
          <Section title="Memory" icon={Database} className="flex-1">
            <div className="font-mono space-y-1">
              {Object.entries(state.memoryValues).map(([addr, val]) => (
                <div
                  key={addr}
                  className="flex justify-between border-b border-gray-800"
                >
                  <span className="text-gray-500">M[{addr}]</span>
                  <span className="text-blue-300">{val}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Log" icon={AlertCircle} className="flex-[2]">
            <div className="font-mono text-[10px] space-y-1">
              {state.log.map((l, i) => (
                <div key={i} className="border-l-2 border-gray-700 pl-1">
                  {l}
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
