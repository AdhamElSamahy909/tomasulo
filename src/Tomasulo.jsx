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
} from "lucide-react";

// --- UTILITIES & PARSING ---

const PARSER_REGEX = {
  // Matches: OP DEST, OFFSET(BASE)  -> L.D F6, 32(R2) or LW R1, 0(R2)
  MEM: /^([A-Z\.]+)\s+([RF]\d+)\s*,\s*(-?\d+)\(([RF]\d+)\)$/i,
  // Matches: OP DEST, SRC1, SRC2    -> ADD.D F6, F2, F4  or ADDI R1, R1, #8
  ALU: /^([A-Z\.]+)\s+([RF]\d+)\s*,\s*([RF]\d+)\s*,\s*(?:#)?([RF0-9\.-]+)$/i,
  // Matches: BNE SRC1, SRC2, LABEL  -> BNE F0, 0, L  (Allows 0 or R0)
  BRANCH: /^(BNE|BEQ)\s+([RF]\d+)\s*,\s*([RF0-9]+)\s*,\s*([A-Z0-9]+)$/i,
  // Matches Label: -> LOOP:
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
const BRANCH_OPS = ["BNE", "BEQ"];
const LOAD_OPS = ["L.D", "L.S", "LW", "LD"];

// --- INITIAL CONFIGURATION ---

const DEFAULT_CONFIG = {
  robSize: 7,
  rsSize: { ADD: 3, MULT: 2, LOAD: 3 },
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

const DEFAULT_CODE = `L.D    F0, 10(R2)
ADD.D  F10, F4, F0
MUL.D  F2, F10, F6
BNE    F2, 0, L
L.D    F4, 0(R3)
ADD.D  F0, F4, F6
S.D    F4, 0(R3)
L:`;

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
  for (let i = 0; i < 32; i++) regs[`R${i}`] = { val: 0, rob: null };
  for (let i = 0; i < 32; i++) regs[`F${i}`] = { val: 0.0, rob: null };

  regs["R2"].val = 0;
  regs["R3"].val = 0;
  regs["F4"].val = 2.0;
  regs["F6"].val = 4.0;

  const memoryValues = { 0: 10.5, 8: 20.25, 10: 50.0 };

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
      id: `${type}${i}`,
      type,
      busy: false,
      op: "",
      vj: null,
      vk: null,
      qj: null,
      qk: null,
      dest: null,
      address: null,
      timer: 0,
      state: "IDLE",
    }));
  });

  const rob = Array.from({ length: config.robSize }, (_, i) => ({
    entry: i + 1,
    busy: false,
    instr: "",
    dest: "",
    value: null,
    stage: "Empty",
    address: null,
    type: "",
    valQ: null,
    // Branch specific tracking within ROB (since no RS)
    qj: null,
    qk: null,
    vj: null,
    vk: null,
    timer: 0,
  }));

  return {
    clock: 0,
    pc: 0,
    instructions,
    labels,
    config,
    rob,
    robHead: 0,
    robTail: 0,
    rs,
    regs,
    memoryValues,
    cache: cacheBlocks,
    log: ["Simulation Ready. Branch Prediction: NOT TAKEN"],
    flushed: false,
  };
};

const reducer = (state, action) => {
  if (action.type === "RESET")
    return generateInitialState(action.config, action.code);

  if (action.type === "STEP") {
    let next = JSON.parse(JSON.stringify(state));
    next.clock++;
    const { config, rob, rs, regs, cache } = next;
    const log = [];

    const addToLog = (msg) => log.unshift(`C${next.clock}: ${msg}`);

    // --- HELPER: CDB BROADCAST ---
    const broadcast = (robId, value, sourceId) => {
      const rEntry = rob.find((r) => r.entry === robId);
      if (rEntry) {
        rEntry.value = value;
        rEntry.stage = "Write";
      }

      // Update RS
      Object.values(next.rs)
        .flat()
        .forEach((unit) => {
          if (unit.busy) {
            if (unit.qj === robId) {
              unit.vj = value;
              unit.qj = null;
            }
            if (unit.qk === robId) {
              unit.vk = value;
              unit.qk = null;
            }
          }
        });

      // Update ROB Stores & Branches (Waiting for dependencies)
      next.rob.forEach((r) => {
        if (!r.busy) return;

        // Stores waiting for Value
        if (STORE_OPS.includes(r.type) && r.valQ === robId) {
          r.value = value;
          r.valQ = null;
          r.stage = "Write";
        }

        // Branches waiting for Operands (qj/qk)
        if (BRANCH_OPS.includes(r.type)) {
          if (r.qj === robId) {
            r.vj = value;
            r.qj = null;
          }
          if (r.qk === robId) {
            r.vk = value;
            r.qk = null;
          }
        }
      });

      addToLog(`${sourceId} broadcast ${value} to ROB#${robId}`);
    };

    // --- STAGE 0: RETIRE ---
    if (rob[next.robHead].stage === "Commit") {
      const finishedEntry = rob[next.robHead];
      rob[next.robHead] = {
        entry: finishedEntry.entry,
        busy: false,
        instr: "",
        dest: "",
        value: null,
        stage: "Empty",
        type: "",
        address: null,
        valQ: null,
        qj: null,
        qk: null,
        vj: null,
        vk: null,
        timer: 0,
      };
      next.robHead = (next.robHead + 1) % config.robSize;
    }

    // --- STAGE 1: COMMIT ---
    const headEntry = rob[next.robHead];

    if (headEntry.busy && headEntry.stage === "Write") {
      headEntry.stage = "Commit";

      if (STORE_OPS.includes(headEntry.type)) {
        const addr = headEntry.address;
        const val = headEntry.value;
        next.memoryValues[addr] = val;

        const blockIndex =
          Math.floor(addr / config.cache.blockSize) % cache.length;
        const tag = Math.floor(addr / config.cache.blockSize);
        if (cache[blockIndex].valid && cache[blockIndex].tag === tag) {
          cache[blockIndex].valid = false;
        }
        addToLog(`Committed ${headEntry.type} ${val} to Mem[${addr}]`);
      } else if (BRANCH_OPS.includes(headEntry.type)) {
        // PREDICT NOT TAKEN LOGIC
        // Value 1 = Taken (Misprediction)

        if (headEntry.value === 1) {
          // Taken -> Misprediction
          addToLog(`Branch Taken (Misprediction) -> FLUSHING`);

          // Restore PC to Target (saved in address field at issue)
          next.pc = headEntry.address;

          // Flush ROB
          for (let i = 0; i < config.robSize; i++) {
            if (i !== next.robHead) {
              next.rob[i] = {
                entry: i + 1,
                busy: false,
                instr: "",
                dest: "",
                value: null,
                stage: "Empty",
                type: "",
                address: null,
                valQ: null,
                qj: null,
                qk: null,
                vj: null,
                vk: null,
              };
            }
          }
          next.robTail = (next.robHead + 1) % config.robSize;

          // Flush RS
          Object.values(next.rs)
            .flat()
            .forEach((u) => {
              u.busy = false;
              u.state = "IDLE";
            });

          // Reset RAT
          Object.values(next.regs).forEach((r) => {
            r.rob = null;
          });

          next.flushed = true;
        } else {
          addToLog(`Branch Not Taken (Correct Prediction)`);
        }
      } else if (headEntry.dest) {
        if (next.regs[headEntry.dest].rob === headEntry.entry) {
          next.regs[headEntry.dest].val = headEntry.value;
          next.regs[headEntry.dest].rob = null;
        }
        addToLog(`Committed ${headEntry.instr}`);
      }
    }

    // --- STAGE 2: EXECUTE & WRITE RESULT (RS & Branch Logic) ---
    if (!next.flushed) {
      // 2a. Standard RS
      Object.keys(rs).forEach((type) => {
        rs[type].forEach((unit) => {
          if (!unit.busy) return;

          const hasOperands = unit.qj === null && unit.qk === null;

          if (unit.state === "IDLE" && hasOperands) {
            unit.state = "EXECUTING";
            const rEntry = rob.find((r) => r.entry === unit.dest);
            if (rEntry && rEntry.stage === "Issued") rEntry.stage = "Exec";
            if (type === "LOAD") unit.address = (unit.vj || 0) + unit.vk;
          }

          if (unit.state === "EXECUTING") {
            // Memory latency handled here
            if (type === "LOAD" && unit.timer === 0) {
              const addr = unit.address;
              // ... cache logic same as before ...
              const blockIdx =
                Math.floor(addr / config.cache.blockSize) % cache.length;
              const tag = Math.floor(addr / config.cache.blockSize);
              const block = cache[blockIdx];
              const isHit = block.valid && block.tag === tag;
              if (isHit) unit.timer = config.cache.hitLatency;
              else {
                unit.timer = config.cache.hitLatency + config.cache.missPenalty;
                cache[blockIdx] = { valid: true, tag, data: "Block" };
              }
            }

            if (unit.timer > 0) unit.timer--;

            if (unit.timer === 0) {
              let result = 0;
              if (type === "LOAD")
                result = next.memoryValues[unit.address] || 0;
              else if (["ADD.D", "ADD.S", "ADDI", "DADDI"].includes(unit.op))
                result = unit.vj + unit.vk;
              else if (["SUB.D", "SUB.S", "SUBI", "DSUBI"].includes(unit.op))
                result = unit.vj - unit.vk;
              else if (["MUL.D", "MUL.S"].includes(unit.op))
                result = unit.vj * unit.vk;
              else if (["DIV.D", "DIV.S"].includes(unit.op))
                result = unit.vj / unit.vk;

              unit.result = result;
              unit.state = "WRITING";
            }
          }

          if (unit.state === "WRITING") {
            broadcast(unit.dest, unit.result, unit.id);
            unit.busy = false;
            unit.state = "IDLE";
          }
        });
      });

      // 2b. Branch Execution (Inside ROB)
      // Check for Branches in 'Issued' state that have ready operands
      next.rob.forEach((r) => {
        if (r.busy && BRANCH_OPS.includes(r.type) && r.stage === "Issued") {
          // Check operands
          if (r.qj === null && r.qk === null) {
            // Operands Ready -> Move to Exec
            r.stage = "Exec";
            // Use configured branch latency
            r.timer = config.latencies[r.type] || 1;
          }
        }

        if (r.busy && BRANCH_OPS.includes(r.type) && r.stage === "Exec") {
          if (r.timer > 0) r.timer--;
          if (r.timer === 0) {
            // Calculate Result
            const op1 = r.vj;
            const op2 = r.vk;
            let taken = 0;
            if (r.type === "BNE") taken = op1 !== op2 ? 1 : 0;
            if (r.type === "BEQ") taken = op1 === op2 ? 1 : 0;

            r.value = taken;
            r.stage = "Write"; // Result Ready
            addToLog(
              `Branch ${r.type} calculated: ${
                taken ? "Taken" : "Not Taken"
              } (ROB#${r.entry})`
            );
          }
        }
      });
    }

    // --- STAGE 3: ISSUE ---
    const robFull = next.rob.filter((r) => r.busy).length >= config.robSize;

    if (!robFull && !next.flushed && next.pc < next.instructions.length) {
      const inst = next.instructions[next.pc];
      if (inst.type === "LABEL") {
        next.pc++;
      } else {
        const isStore = STORE_OPS.includes(inst.op);
        const isBranch = BRANCH_OPS.includes(inst.op);

        if (isStore) {
          const getRegVal = (regName) => {
            if (!isNaN(regName)) return { val: parseFloat(regName), rob: null };
            const r = next.regs[regName];
            if (r.rob !== null) {
              const robDep = next.rob.find((rb) => rb.entry === r.rob);
              if (robDep && robDep.stage === "Write")
                return { val: robDep.value, rob: null };
              return { val: null, rob: r.rob };
            }
            return { val: r.val, rob: null };
          };

          const base = getRegVal(inst.rs);

          if (base.rob !== null) {
            addToLog(`Stall: Waiting for Addr Base (${inst.rs})`);
          } else {
            const address = base.val + inst.imm;
            const valToStore = getRegVal(inst.dest);

            const robIndex = next.robTail;
            const robEntry = next.rob[robIndex];

            robEntry.busy = true;
            robEntry.instr = inst.text;
            robEntry.type = inst.op;
            robEntry.dest = null;
            robEntry.address = address;
            robEntry.stage = "Issued";

            if (valToStore.rob === null) {
              robEntry.value = valToStore.val;
              robEntry.valQ = null;
              robEntry.stage = "Write";
            } else {
              robEntry.value = null;
              robEntry.valQ = valToStore.rob;
            }

            next.robTail = (next.robTail + 1) % config.robSize;
            next.pc++;
            addToLog(`Issued ${inst.op} to ROB#${robEntry.entry}`);
          }
        } else if (isBranch) {
          // --- BRANCH ISSUE (Non-Blocking) ---
          const getRegVal = (regName) => {
            if (!isNaN(regName)) return { val: parseFloat(regName), rob: null };
            const r = next.regs[regName];
            if (r.rob !== null) {
              const robDep = next.rob.find((rb) => rb.entry === r.rob);
              // Check if available from ROB right now
              if (
                robDep &&
                (robDep.stage === "Write" || robDep.stage === "Commit")
              )
                return { val: robDep.value, rob: null };
              return { val: null, rob: r.rob };
            }
            return { val: r.val, rob: null };
          };

          const rs1 = getRegVal(inst.rs);
          const rs2 = getRegVal(inst.rt);

          const robIndex = next.robTail;
          const robEntry = next.rob[robIndex];

          robEntry.busy = true;
          robEntry.instr = inst.text;
          robEntry.type = inst.op;
          robEntry.dest = null;
          robEntry.address = next.labels[inst.target];
          robEntry.stage = "Issued";

          // Set Dependencies in ROB Entry
          robEntry.vj = rs1.val;
          robEntry.qj = rs1.rob;
          robEntry.vk = rs2.val;
          robEntry.qk = rs2.rob;

          next.robTail = (next.robTail + 1) % config.robSize;

          // PREDICT NOT TAKEN: Just go next
          next.pc++;
          addToLog(
            `Issued ${inst.op} to ROB#${robEntry.entry} (Predict Not Taken)`
          );
        } else {
          let type = "";
          if (LOAD_OPS.includes(inst.op)) type = "LOAD";
          else if (["MUL.D", "DIV.D", "MUL.S", "DIV.S"].includes(inst.op))
            type = "MULT";
          else type = "ADD";

          const freeRSIndex = next.rs[type].findIndex((u) => !u.busy);

          if (freeRSIndex !== -1) {
            const rsUnit = next.rs[type][freeRSIndex];
            const robIndex = next.robTail;
            const robEntry = next.rob[robIndex];
            const robId = robEntry.entry;

            robEntry.busy = true;
            robEntry.instr = inst.text;
            robEntry.dest = inst.dest;
            robEntry.type = inst.op;
            robEntry.stage = "Issued";
            robEntry.valQ = null;
            next.robTail = (next.robTail + 1) % config.robSize;

            rsUnit.busy = true;
            rsUnit.op = inst.op;
            rsUnit.dest = robId;
            rsUnit.timer = config.latencies[inst.op] || 1;
            rsUnit.state = "IDLE";

            const getRegVal = (regName) => {
              if (!isNaN(regName))
                return { val: parseFloat(regName), rob: null };
              const r = next.regs[regName];
              if (!r) return { val: 0, rob: null };
              if (r.rob !== null) {
                const robDep = next.rob.find((rb) => rb.entry === r.rob);
                if (
                  robDep &&
                  (robDep.stage === "Write" || robDep.stage === "Commit")
                )
                  return { val: robDep.value, rob: null };
                return { val: null, rob: r.rob };
              }
              return { val: r.val, rob: null };
            };

            if (type === "LOAD") {
              const base = getRegVal(inst.rs);
              rsUnit.vj = base.val;
              rsUnit.qj = base.rob;
              rsUnit.vk = inst.imm;
              if (inst.dest) next.regs[inst.dest].rob = robId;
            } else {
              const src1 = getRegVal(inst.src1);
              const src2 = getRegVal(inst.src2);
              rsUnit.vj = src1.val;
              rsUnit.qj = src1.rob;
              rsUnit.vk = src2.val;
              rsUnit.qk = src2.rob;
              if (inst.dest) next.regs[inst.dest].rob = robId;
            }

            next.pc++;
            addToLog(`Issued ${inst.text} to RS:${rsUnit.id} ROB:#${robId}`);
          } else {
            addToLog(`Stall: No RS for ${inst.op}`);
          }
        }
      }
    }

    next.flushed = false;
    next.log = [...log, ...next.log].slice(0, 50);
    return next;
  }
  return state;
};

// --- COMPONENTS ---

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

  const updateCombinedLatency = (val) => {
    const intVal = parseInt(val);
    setConfig((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      [
        "ADD.D",
        "ADD.S",
        "SUB.D",
        "SUB.S",
        "ADDI",
        "SUBI",
        "DADDI",
        "DSUBI",
      ].forEach((k) => (next.latencies[k] = intVal));
      return next;
    });
  };

  const updateLatency = (ops, val) => {
    const intVal = parseInt(val);
    setConfig((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      ops.forEach((k) => (next.latencies[k] = intVal));
      return next;
    });
  };

  return (
    <div className="p-6 max-w-4xl mx-auto bg-gray-900 text-gray-100 rounded-xl shadow-2xl">
      <div className="flex items-center gap-3 mb-6 border-b border-gray-700 pb-4">
        <Settings className="text-blue-400" />
        <h1 className="text-2xl font-bold">System Configuration</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="space-y-4">
          <h3 className="font-bold text-blue-300 uppercase tracking-wider text-sm">
            Structure Sizes
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-sm">
              ROB Entries
              <input
                type="number"
                value={config.robSize}
                onChange={(e) => updateVal("robSize", e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
            <label className="text-sm">
              Load Buffers
              <input
                type="number"
                value={config.rsSize.LOAD}
                onChange={(e) => updateVal("rsSize.LOAD", e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
            <label className="text-sm">
              Add/Sub RS
              <input
                type="number"
                value={config.rsSize.ADD}
                onChange={(e) => updateVal("rsSize.ADD", e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
            <label className="text-sm">
              Mult/Div RS
              <input
                type="number"
                value={config.rsSize.MULT}
                onChange={(e) => updateVal("rsSize.MULT", e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="font-bold text-yellow-300 uppercase tracking-wider text-sm">
            Instruction Latencies
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-sm col-span-2">
              Add/Sub (FP & Int)
              <input
                type="number"
                defaultValue={2}
                onChange={(e) => updateCombinedLatency(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
            <label className="text-sm">
              Multiplication
              <input
                type="number"
                value={config.latencies["MUL.D"]}
                onChange={(e) =>
                  updateLatency(["MUL.D", "MUL.S"], e.target.value)
                }
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
            <label className="text-sm">
              Division
              <input
                type="number"
                value={config.latencies["DIV.D"]}
                onChange={(e) =>
                  updateLatency(["DIV.D", "DIV.S"], e.target.value)
                }
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
            <label className="text-sm">
              Load / Store
              <input
                type="number"
                value={config.latencies["L.D"]}
                onChange={(e) =>
                  updateLatency(
                    ["L.D", "L.S", "LW", "LD", "S.D", "S.S", "SW", "SD"],
                    e.target.value
                  )
                }
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
          </div>
        </div>

        <div className="space-y-4 col-span-1 md:col-span-2">
          <h3 className="font-bold text-green-300 uppercase tracking-wider text-sm">
            Memory & Cache
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <label className="text-sm">
              Total Size (Bytes)
              <input
                type="number"
                value={config.cache.size}
                onChange={(e) => updateVal("cache.size", e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
            <label className="text-sm">
              Block Size
              <input
                type="number"
                value={config.cache.blockSize}
                onChange={(e) => updateVal("cache.blockSize", e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
            <label className="text-sm">
              Hit Latency
              <input
                type="number"
                value={config.cache.hitLatency}
                onChange={(e) => updateVal("cache.hitLatency", e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
            <label className="text-sm">
              Miss Penalty
              <input
                type="number"
                value={config.cache.missPenalty}
                onChange={(e) => updateVal("cache.missPenalty", e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 mt-1"
              />
            </label>
          </div>
        </div>
      </div>

      <button
        onClick={() => onStart(config)}
        className="mt-8 w-full py-3 bg-blue-600 hover:bg-blue-500 rounded font-bold text-white transition-colors"
      >
        Initialize Simulation
      </button>
    </div>
  );
};

const RegisterGrid = ({ regs, filter }) => (
  <div className="grid grid-cols-4 md:grid-cols-8 gap-1">
    {Object.keys(regs)
      .filter((k) => k.startsWith(filter))
      .map((key) => {
        const r = regs[key];
        return (
          <div
            key={key}
            className={`p-1 rounded text-[10px] border ${
              r.rob
                ? "border-yellow-600 bg-yellow-900/20"
                : "border-gray-700 bg-gray-800"
            }`}
          >
            <div className="flex justify-between">
              <span className="font-bold text-gray-400">{key}</span>
              {r.rob && <span className="text-yellow-400">#{r.rob}</span>}
            </div>
            <div className="truncate text-gray-200">
              {typeof r.val === "number" ? r.val.toFixed(1) : r.val}
            </div>
          </div>
        );
      })}
  </div>
);

const MemoryView = ({ memoryValues, size }) => {
  const rows = Math.ceil(size / 8);
  return (
    <div className="h-full overflow-y-auto font-mono text-xs">
      {Array.from({ length: rows }).map((_, rIdx) => (
        <div
          key={rIdx}
          className="flex border-b border-gray-800 hover:bg-gray-800"
        >
          <div className="w-12 text-gray-500 py-1 bg-gray-900 px-2">
            {rIdx * 8}
          </div>
          <div className="flex-1 flex">
            {Array.from({ length: 8 }).map((_, bIdx) => {
              const addr = rIdx * 8 + bIdx;
              const val = memoryValues[addr];
              return (
                <div
                  key={addr}
                  className={`flex-1 flex justify-center py-1 border-r border-gray-800 ${
                    val
                      ? "bg-blue-900/30 text-blue-300 font-bold"
                      : "text-gray-600"
                  }`}
                >
                  {val ? val : "00"}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

const CacheView = ({ blocks, blockSize }) => (
  <div className="h-full overflow-y-auto text-xs">
    <table className="w-full text-left">
      <thead className="bg-gray-800 text-gray-400">
        <tr>
          <th className="p-1">Blk</th>
          <th className="p-1">V</th>
          <th className="p-1">Tag</th>
          <th className="p-1">Data</th>
        </tr>
      </thead>
      <tbody>
        {blocks.map((b, i) => (
          <tr key={i} className="border-b border-gray-800">
            <td className="p-1 text-gray-500">{i}</td>
            <td className="p-1">
              {b.valid ? (
                <span className="text-green-500">1</span>
              ) : (
                <span className="text-red-500">0</span>
              )}
            </td>
            <td className="p-1 font-mono text-yellow-500">
              {b.tag !== null ? b.tag : "-"}
            </td>
            <td className="p-1 text-gray-400">
              {b.valid ? "Active" : "Empty"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default function TomasuloSimulator() {
  const [config, setConfig] = useState(null);
  const [code, setCode] = useState(DEFAULT_CODE);
  const [state, dispatch] = useReducer(reducer, null);
  const [activeTab, setActiveTab] = useState("FP");

  const startSim = (cfg) => {
    setConfig(cfg);
    dispatch({ type: "RESET", config: cfg, code });
  };

  if (!config || !state) return <ConfigScreen onStart={startSim} />;

  return (
    <div className="h-screen bg-gray-950 text-gray-100 flex flex-col font-sans overflow-hidden">
      {/* TOOLBAR */}
      <div className="bg-gray-900 border-b border-gray-800 p-2 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="font-bold text-lg bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent ml-2">
            Tomasulo Sim
          </h1>
          <div className="h-6 w-px bg-gray-700"></div>
          <div className="flex gap-2">
            <button
              onClick={() => dispatch({ type: "STEP" })}
              className="flex items-center gap-2 bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded text-sm font-medium"
            >
              <SkipForward size={14} /> Step
            </button>
            <button
              onClick={() => setConfig(null)}
              className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-sm"
            >
              <Settings size={14} /> Config
            </button>
            <button
              onClick={() => dispatch({ type: "RESET", config, code })}
              className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-sm"
            >
              <RotateCcw size={14} /> Reset
            </button>
          </div>
        </div>
        <div className="flex items-center gap-4 mr-4">
          <span className="text-gray-400 text-xs uppercase">Clock</span>
          <span className="text-2xl font-mono font-bold text-white">
            {state.clock}
          </span>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT COLUMN: Code & Queue & Log */}
        <div className="w-80 flex flex-col border-r border-gray-800 bg-gray-900/50">
          <div className="h-1/3 p-2 flex flex-col border-b border-gray-800">
            <div className="flex justify-between mb-1 text-xs font-bold text-gray-500 uppercase">
              <span>Instruction Queue</span>
              <span>PC: {state.pc}</span>
            </div>
            <div className="flex-1 overflow-auto bg-gray-950 rounded border border-gray-800 font-mono text-xs p-2">
              {state.instructions.map((inst, i) => (
                <div
                  key={i}
                  className={`${
                    i === state.pc
                      ? "bg-blue-900/50 text-white ring-1 ring-blue-500"
                      : i < state.pc
                      ? "text-gray-600"
                      : "text-gray-400"
                  } px-1 rounded`}
                >
                  {inst.type === "LABEL" ? (
                    <span className="text-yellow-500 font-bold">
                      {inst.label}:
                    </span>
                  ) : (
                    <span className="ml-4">{inst.text}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="h-1/3 border-b border-gray-800 flex flex-col">
            <div className="bg-gray-800 px-2 py-1 text-xs font-bold text-gray-400 flex items-center gap-2">
              <AlertCircle size={12} /> Event Log
            </div>
            <div className="flex-1 overflow-auto p-2 font-mono text-[10px] space-y-1">
              {state.log.map((l, i) => (
                <div
                  key={i}
                  className="text-gray-400 border-l-2 border-gray-700 pl-1"
                >
                  {l}
                </div>
              ))}
            </div>
          </div>

          <div className="flex-1 flex flex-col">
            <div className="bg-gray-800 px-2 py-1 text-xs font-bold text-gray-400 flex items-center gap-2">
              <Edit3 size={12} /> Editor
            </div>
            <textarea
              className="flex-1 bg-gray-950 p-2 font-mono text-xs text-gray-300 resize-none focus:outline-none"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
        </div>

        {/* MIDDLE COLUMN: Execution Units & RS */}
        <div className="flex-1 flex flex-col min-w-0 bg-gray-950 overflow-y-auto">
          {/* REGISTER FILE */}
          <div className="p-2 border-b border-gray-800">
            <div className="flex gap-4 mb-2">
              <button
                onClick={() => setActiveTab("FP")}
                className={`text-xs font-bold px-2 py-1 rounded ${
                  activeTab === "FP"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-800 text-gray-400"
                }`}
              >
                Floating Point (F0-F31)
              </button>
              <button
                onClick={() => setActiveTab("R")}
                className={`text-xs font-bold px-2 py-1 rounded ${
                  activeTab === "R"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-800 text-gray-400"
                }`}
              >
                Integer (R0-R31)
              </button>
            </div>
            <RegisterGrid
              regs={state.regs}
              filter={activeTab === "FP" ? "F" : "R"}
            />
          </div>

          {/* RESERVATION STATIONS */}
          <div className="p-2 space-y-4">
            {Object.entries(state.rs).map(([type, units]) => (
              <div
                key={type}
                className="border border-gray-800 rounded overflow-hidden"
              >
                <div className="bg-gray-900 px-3 py-1 text-xs font-bold text-gray-400 uppercase flex justify-between">
                  <span className="flex items-center gap-2">
                    <Cpu size={12} /> {type} Station
                  </span>
                  <span className="text-gray-600">Size: {units.length}</span>
                </div>
                <table className="w-full text-xs text-left">
                  <thead className="bg-gray-800/50 text-gray-500">
                    <tr>
                      <th className="p-1">ID</th>
                      <th className="p-1">Busy</th>
                      <th className="p-1">Op</th>
                      <th className="p-1">Vj</th>
                      <th className="p-1">Vk</th>
                      <th className="p-1">Qj</th>
                      <th className="p-1">Qk</th>
                      <th className="p-1">Dest (ROB)</th>
                      <th className="p-1">Timer</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {units.map((u) => (
                      <tr key={u.id} className={u.busy ? "bg-gray-900" : ""}>
                        <td className="p-1 font-medium text-blue-300">
                          {u.id}
                        </td>
                        <td className="p-1">{u.busy ? "Yes" : "No"}</td>
                        <td className="p-1">{u.op}</td>
                        <td className="p-1 font-mono text-gray-400">
                          {u.vj !== null
                            ? typeof u.vj === "number"
                              ? u.vj.toFixed(0)
                              : u.vj
                            : ""}
                        </td>
                        <td className="p-1 font-mono text-gray-400">
                          {u.vk !== null
                            ? typeof u.vk === "number"
                              ? u.vk.toFixed(0)
                              : u.vk
                            : ""}
                        </td>
                        <td className="p-1 text-yellow-500">
                          {u.qj ? `#${u.qj}` : ""}
                        </td>
                        <td className="p-1 text-yellow-500">
                          {u.qk ? `#${u.qk}` : ""}
                        </td>
                        <td className="p-1 text-green-500">
                          {u.busy ? `#${u.dest}` : ""}
                        </td>
                        <td className="p-1 font-bold text-white">
                          {u.timer > 0 ? u.timer : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN: ROB, Memory, Cache */}
        <div className="w-96 flex flex-col border-l border-gray-800 bg-gray-900/30">
          {/* ROB */}
          <div className="flex-[2] border-b border-gray-800 flex flex-col min-h-0">
            <div className="bg-gray-800 px-2 py-1 text-xs font-bold text-gray-400 flex items-center gap-2">
              <Layers size={12} /> Re-Order Buffer (ROB)
            </div>
            <div className="flex-1 overflow-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-gray-800/50 sticky top-0 text-gray-400">
                  <tr>
                    <th className="p-1">#</th>
                    <th className="p-1">Type</th>
                    <th className="p-1">Dest</th>
                    <th className="p-1">Value</th>
                    <th className="p-1">Ready</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {state.rob.map((r, i) => {
                    const isHead = i === state.robHead;
                    let destDisplay = "-";
                    if (STORE_OPS.includes(r.type)) {
                      destDisplay =
                        r.stage === "Write" || r.stage === "Commit"
                          ? `Mem[${r.address}]`
                          : "Addr?";
                    } else if (BRANCH_OPS.includes(r.type)) {
                      destDisplay = "-";
                    } else {
                      destDisplay = r.dest || "-";
                    }

                    // Determine Style for Ready Col
                    let readyColor = "text-gray-500";
                    if (r.stage === "Issued") readyColor = "text-yellow-500";
                    if (r.stage === "Exec") readyColor = "text-blue-400";
                    if (r.stage === "Write") readyColor = "text-green-400";
                    if (r.stage === "Commit")
                      readyColor = "text-purple-400 font-bold";

                    return (
                      <tr
                        key={r.entry}
                        className={`${r.busy ? "bg-gray-800/50" : ""} ${
                          isHead
                            ? "border-l-2 border-green-500 bg-green-900/10"
                            : ""
                        }`}
                      >
                        <td className="p-1 font-mono text-yellow-500">
                          #{r.entry}
                        </td>
                        <td className="p-1 text-gray-400">{r.type}</td>
                        <td className="p-1 text-blue-300">{destDisplay}</td>
                        <td className="p-1 font-mono">
                          {STORE_OPS.includes(r.type) ? (
                            r.valQ ? (
                              <span className="text-yellow-500">
                                Wait #{r.valQ}
                              </span>
                            ) : r.value !== null ? (
                              r.value
                            ) : (
                              "-"
                            )
                          ) : r.value !== null ? (
                            r.value
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className={`p-1 ${readyColor}`}>
                          {r.stage === "Empty" ? "" : r.stage}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* CACHE & MEMORY */}
          <div className="flex-1 flex flex-row min-h-0">
            <div className="flex-1 flex flex-col border-r border-gray-800">
              <div className="bg-gray-800 px-2 py-1 text-xs font-bold text-gray-400 flex items-center gap-2">
                <MemoryStick size={12} /> Cache ({config.cache.size}B)
              </div>
              <CacheView
                blocks={state.cache}
                blockSize={config.cache.blockSize}
              />
            </div>
            <div className="flex-1 flex flex-col">
              <div className="bg-gray-800 px-2 py-1 text-xs font-bold text-gray-400 flex items-center gap-2">
                <Database size={12} /> Memory
              </div>
              <MemoryView
                memoryValues={state.memoryValues}
                size={config.memorySize}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
