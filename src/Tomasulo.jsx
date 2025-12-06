import React, { useState, useReducer, useEffect } from "react";
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
  Plus,
  Trash2,
  FileText,
  AlertTriangle,
  X,
} from "lucide-react";

// ==========================================
// 1. CONSTANTS
// ==========================================

const OPCODES = [
  "L.D",
  "L.S",
  "LW",
  "LD",
  "S.D",
  "S.S",
  "SW",
  "SD",
  "ADD.D",
  "ADD.S",
  "SUB.D",
  "SUB.S",
  "MUL.D",
  "MUL.S",
  "DIV.D",
  "DIV.S",
  "ADDI",
  "SUBI",
  "DADDI",
  "DSUBI",
  "DADDIU",
  "DSLTU",
  "BNE",
  "BEQ",
  "BNEZ",
  "BEQZ",
];

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
    size: 64,
    blockSize: 8,
    hitLatency: 1,
    missPenalty: 10,
  },
  memorySize: 256,
};

const DEFAULT_CODE = `MUL.D R3, R1, R2
ADD.D R5, R3, R4
ADD.D R7, R2, R6
ADD.D R10, R8, R9
MUL.D R11, R7, R10
ADD.D R5, R5, R11`;

// ==========================================
// 2. UTILITIES
// ==========================================

const parseInstruction = (line) => {
  let cleanLine = line.trim().replace(/,/g, " ");
  cleanLine = cleanLine.replace(/([A-Z])\.\s+([A-Z])/gi, "$1.$2");
  cleanLine = cleanLine.replace(/\s+/g, " ");

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
  else if (["MUL.D", "MUL.S", "DIV.D", "DIV.S"].includes(op)) type = "MULT";
  else type = "ADD";

  return { text: instruction, label, op, tokens: tokens.slice(1), type };
};

const toBinary32 = (num) => (num >>> 0).toString(2).padStart(32, "0");

// ==========================================
// 3. LOGIC & REDUCER
// ==========================================

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

  instructions.forEach((inst) => {
    if (inst.type === "BRANCH") {
      let labelTokenIdx = ["BNEZ", "BEQZ"].includes(inst.op) ? 1 : 2;
      if (inst.tokens[labelTokenIdx]) {
        const labelName = inst.tokens[labelTokenIdx];
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

  regs["R1"].val = 32;
  regs["R2"].val = 0;
  regs["F2"].val = 0.5;
  regs["F4"].val = 4.0;

  const memory = {};
  for (let i = 0; i < config.memorySize; i += 4) memory[i] = 0;
  memory[0] = 10.0;
  memory[8] = 20.0;
  memory[32] = 100.0;

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
      subState: "NONE",
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
    modalMsg: null,
  };
};

const reducer = (state, action) => {
  if (action.type === "EXIT") return null;
  if (action.type === "CLOSE_MODAL") return { ...state, modalMsg: null };
  if (action.type === "RESET")
    return generateInitialState(action.config, action.code);

  if (action.type === "STEP") {
    let next = JSON.parse(JSON.stringify(state));
    next.clock++;
    next.stalledPc = null;
    next.modalMsg = null;

    // 1. WRITE RESULT (Arbitration)
    const writeCandidates = [];
    Object.values(next.rs)
      .flat()
      .forEach((u) => {
        if (u.state === "WRITE_READY") {
          if (u.type === "STORE") {
            if (u.qk === null) writeCandidates.push(u);
          } else writeCandidates.push(u);
        }
      });

    if (writeCandidates.length > 0) {
      writeCandidates.sort((a, b) => {
        // 1. Dep Count
        let depA = 0,
          depB = 0;
        Object.values(next.rs)
          .flat()
          .forEach((o) => {
            if (o.busy && (o.qj === a.id || o.qk === a.id)) depA++;
            if (o.busy && (o.qj === b.id || o.qk === b.id)) depB++;
          });
        if (depA !== depB) return depB - depA;

        // 2. Ready Count
        let readyA = 0,
          readyB = 0;
        Object.values(next.rs)
          .flat()
          .forEach((o) => {
            if (o.busy) {
              if (
                (o.qj === a.id && o.qk === null) ||
                (o.qk === a.id && o.qj === null) ||
                (o.qj === a.id && o.qk === a.id)
              )
                readyA++;
              if (
                (o.qj === b.id && o.qk === null) ||
                (o.qk === b.id && o.qj === null) ||
                (o.qj === b.id && o.qk === b.id)
              )
                readyB++;
            }
          });
        if (readyA !== readyB) return readyB - readyA;

        const p = { BRANCH: 4, STORE: 3, LOAD: 2, MULT: 1, ADD: 0 };
        if (p[a.type] !== p[b.type]) return p[b.type] - p[a.type];

        return a.instIdx - b.instIdx;
      });

      const winner = writeCandidates[0];

      if (writeCandidates.length > 1) {
        const runnerUp = writeCandidates[1];
        let reason = "Issued earlier";
        let depW = 0,
          depR = 0;
        Object.values(next.rs)
          .flat()
          .forEach((o) => {
            if (o.busy && (o.qj === winner.id || o.qk === winner.id)) depW++;
            if (o.busy && (o.qj === runnerUp.id || o.qk === runnerUp.id))
              depR++;
          });
        const p = { BRANCH: 4, STORE: 3, LOAD: 2, MULT: 1, ADD: 0 };

        if (depW > depR) reason = "Higher priority or unblocks more unit";
        else if (p[winner.type] > p[runnerUp.type])
          reason = "Higher priority or unblocks more unit";

        const losers = writeCandidates
          .slice(1)
          .map((c) => c.op)
          .join(", ");
        next.modalMsg = {
          title: `Write Conflict Cycle ${next.clock}`,
          winner: `${winner.op}`,
          losers: losers,
          reason: reason,
        };
      }

      if (winner.type === "STORE") {
        next.memory[winner.address] = winner.vk;
      } else if (winner.type === "BRANCH") {
        const tAddr = parseInt(winner.address);
        if (winner.result && !isNaN(tAddr)) {
          next.pc = tAddr;
          next.iteration++;
        }
        next.branchStall = false;
      } else {
        const res = winner.result;
        Object.values(next.regs).forEach((r) => {
          if (r.qi === winner.id) {
            r.val = res;
            r.qi = null;
          }
        });
        Object.values(next.rs)
          .flat()
          .forEach((rs) => {
            if (rs.qj === winner.id) {
              rs.vj = res;
              rs.qj = null;
            }
            if (rs.qk === winner.id) {
              rs.vk = res;
              rs.qk = null;
            }
          });
      }
      next.instStatus[winner.instIdx].writeRes = next.clock;

      const typeList = next.rs[winner.type];
      const rsIndex = typeList.findIndex((r) => r.id === winner.id);
      if (rsIndex !== -1) {
        typeList[rsIndex] = {
          ...typeList[rsIndex],
          busy: false,
          state: "IDLE",
          instIdx: -1,
          op: "",
          vj: null,
          vk: null,
          qj: null,
          qk: null,
          address: null,
          subState: "NONE",
        };
      }
    }

    // 2. EXECUTE
    Object.values(next.rs)
      .flat()
      .forEach((u) => {
        if (!u.busy) return;

        if (u.state === "ISSUE" && u.qj === null && u.qk === null) {
          u.state = "EXEC";
          next.instStatus[u.instIdx].execStart = next.clock;

          if (u.type === "LOAD") {
            // STEP 1: Addr Calc + Hit Time
            u.subState = "INITIAL_ACCESS";
            // FORCE INITIAL TIME = LATENCY + HIT
            u.timer =
              (next.config.latencies[u.op] || 1) + next.config.cache.hitLatency;
          } else if (u.type === "STORE") {
            u.subState = "ADDR_CALC";
            u.timer = next.config.latencies[u.op] || 1;
          } else {
            u.subState = "EXEC";
            u.timer = next.config.latencies[u.op] || 1;
          }
        }

        if (u.state === "EXEC") {
          if (u.timer > 0) u.timer--;

          if (u.timer === 0) {
            if (u.subState === "INITIAL_ACCESS") {
              u.address = (u.vj || 0) + (u.address || 0);
              const addr = u.address;
              const rawIdx = Math.floor(addr / next.config.cache.blockSize);
              const n = next.cache.length;
              const blockIdx = ((rawIdx % n) + n) % n;
              const tag = Math.floor(rawIdx / n);

              if (next.cache[blockIdx]) {
                const blk = next.cache[blockIdx];
                const isHit = blk.valid && blk.tag === tag;

                if (isHit) {
                  blk.history.push(`Hit C${next.clock}`);
                  u.result = next.memory[addr] ?? 0;
                  u.state = "WRITE_READY";
                  next.instStatus[u.instIdx].execComp = next.clock;
                } else {
                  u.subState = "MISS_PENALTY";
                  u.timer = next.config.cache.missPenalty;
                  blk.history.push(`Miss C${next.clock}`);

                  // If miss penalty is zero, complete the fill immediately
                  // instead of waiting an extra cycle. This avoids an
                  // off-by-one when miss penalty is set to 0.
                  if (u.timer === 0) {
                    next.cache[blockIdx] = {
                      ...next.cache[blockIdx],
                      valid: true,
                      tag,
                      data: `M[${Math.floor(addr / 8) * 8}]`,
                      history: [...next.cache[blockIdx].history, `Fill C${next.clock}`],
                    };

                    u.result = next.memory[addr] ?? 0;
                    u.state = "WRITE_READY";
                    next.instStatus[u.instIdx].execComp = next.clock;
                  }
                }
              } else {
                u.timer = next.config.cache.missPenalty;
              }
            } else if (u.subState === "MISS_PENALTY") {
              const addr = u.address;
              const rawIdx = Math.floor(addr / next.config.cache.blockSize);
              const n = next.cache.length;
              const blockIdx = ((rawIdx % n) + n) % n;
              const tag = Math.floor(rawIdx / n);

              next.cache[blockIdx] = {
                ...next.cache[blockIdx],
                valid: true,
                tag,
                data: `M[${Math.floor(addr / 8) * 8}]`,
                history: [
                  ...next.cache[blockIdx].history,
                  `Fill C${next.clock}`,
                ],
              };

              u.result = next.memory[addr] ?? 0;
              u.state = "WRITE_READY";
              next.instStatus[u.instIdx].execComp = next.clock;
            } else if (u.subState === "ADDR_CALC") {
              u.address = (u.vj || 0) + (u.address || 0);
              u.state = "WRITE_READY";
              next.instStatus[u.instIdx].execComp = next.clock;
            } else {
              u.state = "WRITE_READY";
              next.instStatus[u.instIdx].execComp = next.clock;

              if (["ADD.D", "ADDI", "DADDI", "DADDIU"].includes(u.op))
                u.result = (parseFloat(u.vj) || 0) + (parseFloat(u.vk) || 0);
              else if (["SUB.D", "SUBI", "DSUBI"].includes(u.op))
                u.result = (parseFloat(u.vj) || 0) - (parseFloat(u.vk) || 0);
              else if (u.op === "MUL.D")
                u.result = (parseFloat(u.vj) || 0) * (parseFloat(u.vk) || 0);
              else if (u.op === "DIV.D")
                u.result = (parseFloat(u.vj) || 0) / (parseFloat(u.vk) || 1);
              else if (u.op === "DSLTU") u.result = u.vj < u.vk ? 1 : 0;
            }
          }
        }
      });

    // 3. ISSUE
    if (!next.branchStall && next.pc < next.instructions.length) {
      const inst = next.instructions[next.pc];
      const getReg = (r) =>
        r.match(/^[RF]\d+$/)
          ? next.regs[r]
          : { val: parseInt(r) || 0, qi: null };

      if (inst.type === "BRANCH") {
        const [Op1, Op2, Label] = inst.tokens;
        const r1 = getReg(Op1);
        let r2 = { val: 0, qi: null };
        if (inst.op !== "BNEZ" && inst.op !== "BEQZ") r2 = getReg(Op2);

        if (r1.qi !== null || r2.qi !== null) {
          next.stalledPc = next.pc;
        } else {
          const val1 = r1.val;
          const val2 = r2.val;
          let taken = false;
          if (inst.op === "BNE") taken = val1 !== val2;
          else if (inst.op === "BEQ") taken = val1 === val2;
          else if (inst.op === "BNEZ") taken = val1 !== 0;
          else if (inst.op === "BEQZ") taken = val1 === 0;

          if (taken) {
            const tLabel = ["BNEZ", "BEQZ"].includes(inst.op) ? Op1 : Label;
            const tAddr = parseInt(tLabel);
            if (!isNaN(tAddr)) {
              next.pc = tAddr;
              next.iteration++;
            } else next.pc++;
          } else next.pc++;
        }
      } else {
        let type = "ADD";
        if (["MUL.D", "DIV.D"].includes(inst.op)) type = "MULT";
        else if (inst.type === "LOAD") type = "LOAD";
        else if (inst.type === "STORE") type = "STORE";

        const unit = next.rs[type].find((u) => !u.busy);
        if (unit) {
          unit.busy = true;
          unit.op = inst.op;
          // Initial Display Timer = Config + Hit (for Load)
          if (inst.type === "LOAD") {
            unit.timer =
              (next.config.latencies[inst.op] || 1) +
              next.config.cache.hitLatency;
          } else {
            unit.timer = next.config.latencies[inst.op] || 1;
          }
          unit.state = "ISSUE";

          const stat = {
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
          unit.instIdx = stat.id;
          next.instStatus.push(stat);

          if (inst.type === "LOAD") {
            const [dest, offStr] = inst.tokens;
            const m = offStr.match(/(-?\d+)\(([A-Z0-9]+)\)/);
            const off = parseInt(m?.[1] || offStr);
            const base = getReg(m?.[2] || "R0");
            if (base.qi) {
              unit.qj = base.qi;
              stat.j = base.qi;
            } else {
              unit.vj = base.val;
              stat.j = base.val;
            }
            unit.address = off;
            if (next.regs[dest]) next.regs[dest].qi = unit.id;
          } else if (inst.type === "STORE") {
            const [src, offStr] = inst.tokens;
            const m = offStr.match(/(-?\d+)\(([A-Z0-9]+)\)/);
            const off = parseInt(m?.[1] || offStr);
            const base = getReg(m?.[2] || "R0");
            const val = getReg(src);
            if (base.qi) {
              unit.qj = base.qi;
              stat.j = base.qi;
            } else {
              unit.vj = base.val;
              stat.j = base.val;
            }
            if (val.qi) {
              unit.qk = val.qi;
              stat.k = val.qi;
            } else {
              unit.vk = val.val;
              stat.k = val.val;
            }
            unit.address = off;
          } else {
            const [dest, s1, s2] = inst.tokens;
            const r1 = getReg(s1);
            const r2 = getReg(s2);
            if (r1.qi) {
              unit.qj = r1.qi;
              stat.j = r1.qi;
            } else {
              unit.vj = r1.val;
              stat.j = r1.val;
            }
            if (r2.qi) {
              unit.qk = r2.qi;
              stat.k = r2.qi;
            } else {
              unit.vk = r2.val;
              stat.k = r2.val;
            }
            if (next.regs[dest]) next.regs[dest].qi = unit.id;
          }
          next.pc++;
        }
      }
    }
    return next;
  }
  return state;
};

// ==========================================
// 4. UI COMPONENTS
// ==========================================

const ConflictModal = ({ msg, onClose }) => {
  if (!msg) return null;
  return (
    <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl max-w-md w-full p-6 relative animate-in fade-in zoom-in duration-200">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-yellow-900/50 rounded-full border border-yellow-600">
            <AlertTriangle className="text-yellow-500" size={24} />
          </div>
          <h2 className="text-lg font-bold text-gray-100">{msg.title}</h2>
        </div>
        <div className="space-y-4 mb-6">
          <div className="bg-green-900/30 border border-green-800 p-3 rounded-lg">
            <p className="text-xs text-green-400 uppercase font-bold mb-1">
              Winner
            </p>
            <p className="text-sm font-mono text-white">{msg.winner}</p>
          </div>
          <div className="bg-red-900/20 border border-red-900/50 p-3 rounded-lg">
            <p className="text-xs text-red-400 uppercase font-bold mb-1">
              Stalled
            </p>
            <p className="text-sm font-mono text-gray-300">{msg.losers}</p>
          </div>
          <div className="text-sm text-gray-300">
            <span className="font-bold text-blue-400">Reason:</span>{" "}
            {msg.reason}
          </div>
        </div>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2 rounded-lg font-bold shadow-lg transition-colors"
          >
            Acknowledged
          </button>
        </div>
      </div>
    </div>
  );
};

const InstructionBuilder = ({ onCodeChange, defaultInstructions }) => {
  const [rows, setRows] = useState(() => {
    const lines = defaultInstructions.split("\n");
    return lines.map((l, i) => {
      const p = parseInstruction(l);
      if (!p)
        return {
          id: i,
          label: "",
          op: "ADD.D",
          dest: "F0",
          s1: "F1",
          s2: "F2",
        };

      const isLoadStore = ["LOAD", "STORE"].includes(p.type);
      const isBranch = p.type === "BRANCH";
      const isBranchZ = ["BNEZ", "BEQZ"].includes(p.op);

      let dest = "",
        s1 = "",
        s2 = "";

      if (isLoadStore) {
        dest = p.tokens[0]?.replace(",", "") || "";
        const m = p.tokens[1]?.match(/(-?\d+)\(([A-Z0-9]+)\)/);
        if (m) {
          s1 = m[1];
          s2 = m[2];
        } else {
          s1 = p.tokens[1] || "0";
          s2 = "R0";
        }
      } else if (isBranch) {
        dest = p.tokens[0]?.replace(",", "") || "";
        if (isBranchZ) {
          s1 = p.tokens[1] || "";
        } else {
          s1 = p.tokens[1]?.replace(",", "") || "";
          s2 = p.tokens[2] || "";
        }
      } else {
        dest = p.tokens[0]?.replace(",", "") || "";
        s1 = p.tokens[1]?.replace(",", "") || "";
        s2 = p.tokens[2] || "";
      }

      return {
        id: Date.now() + i,
        label: p.label || "",
        op: p.op,
        dest,
        s1,
        s2,
      };
    });
  });

  useEffect(() => {
    const text = rows
      .map((r) => {
        const lbl = r.label ? `${r.label}: ` : "";
        const op = r.op;
        let args = "";
        const isLS = [
          "L.D",
          "L.S",
          "LW",
          "LD",
          "S.D",
          "S.S",
          "SW",
          "SD",
        ].includes(op);
        const isBZ = ["BNEZ", "BEQZ"].includes(op);
        const isB = ["BNE", "BEQ"].includes(op);
        const isImm = [
          "ADDI",
          "SUBI",
          "DADDI",
          "DSUBI",
          "DADDIU",
          "DSLTU",
        ].includes(op);

        if (isLS) {
          args = `${r.dest}, ${r.s1}(${r.s2})`;
        } else if (isBZ) {
          args = `${r.dest}, ${r.s1}`;
        } else if (isImm) {
          args = `${r.dest}, ${r.s1}, ${r.s2}`;
        } else {
          args = `${r.dest}, ${r.s1}, ${r.s2}`;
        }
        return `${lbl}${op} ${args}`;
      })
      .join("\n");
    onCodeChange(text);
  }, [rows, onCodeChange]);

  const addRow = () =>
    setRows([
      ...rows,
      {
        id: Date.now(),
        label: "",
        op: "ADD.D",
        dest: "F0",
        s1: "F2",
        s2: "F4",
      },
    ]);
  const removeRow = (id) => setRows(rows.filter((r) => r.id !== id));
  const updateRow = (id, field, val) =>
    setRows(rows.map((r) => (r.id === id ? { ...r, [field]: val } : r)));

  const ALL_REGS = [
    ...Array.from({ length: 32 }, (_, i) => `F${i}`),
    ...Array.from({ length: 32 }, (_, i) => `R${i}`),
  ];

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 h-96 flex flex-col">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-sm font-bold text-gray-400 uppercase flex items-center gap-2">
          <Code size={14} /> Instruction Builder
        </h3>
        <button
          onClick={addRow}
          className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded flex items-center gap-1"
        >
          <Plus size={12} /> Add
        </button>
      </div>
      <div className="overflow-y-auto custom-scrollbar flex-1 space-y-1">
        <div className="grid grid-cols-[30px_80px_90px_70px_70px_70px_30px] gap-2 px-1 py-2 text-[10px] font-bold text-gray-500 uppercase border-b border-gray-800 mb-1">
          <div className="text-center">#</div>
          <div>Label</div>
          <div>Opcode</div>
          <div>Dest/Op1</div>
          <div>Src1/Off</div>
          <div>Src2/Base</div>
          <div></div>
        </div>

        {rows.map((r, idx) => {
          const isLS = [
            "L.D",
            "L.S",
            "LW",
            "LD",
            "S.D",
            "S.S",
            "SW",
            "SD",
          ].includes(r.op);
          const isBranch = ["BNE", "BEQ", "BNEZ", "BEQZ"].includes(r.op);
          const isBZ = ["BNEZ", "BEQZ"].includes(r.op);
          const isImm = [
            "ADDI",
            "SUBI",
            "DADDI",
            "DSUBI",
            "DADDIU",
            "DSLTU",
          ].includes(r.op);

          return (
            <div
              key={r.id}
              className="grid grid-cols-[30px_80px_90px_70px_70px_70px_30px] gap-2 items-center p-1.5 rounded hover:bg-gray-800 transition-colors group"
            >
              <div className="text-gray-600 text-[10px] font-mono text-center">
                {idx}
              </div>

              <input
                placeholder="Label"
                className="bg-transparent border border-transparent hover:border-gray-700 focus:border-blue-500 rounded px-1.5 py-1 text-xs text-yellow-500 placeholder-gray-700 outline-none transition-all font-mono"
                value={r.label}
                onChange={(e) => updateRow(r.id, "label", e.target.value)}
              />

              <div className="relative">
                <select
                  className="w-full appearance-none bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-blue-300 font-bold outline-none focus:border-blue-500 cursor-pointer"
                  value={r.op}
                  onChange={(e) => updateRow(r.id, "op", e.target.value)}
                >
                  {OPCODES.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>

              <div className="relative">
                <select
                  className="w-full appearance-none bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-blue-500 cursor-pointer"
                  value={r.dest}
                  onChange={(e) => updateRow(r.id, "dest", e.target.value)}
                >
                  {ALL_REGS.map((rg) => (
                    <option key={rg} value={rg}>
                      {rg}
                    </option>
                  ))}
                </select>
              </div>

              {isLS ? (
                <input
                  placeholder="Off"
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-green-400 outline-none focus:border-blue-500"
                  value={r.s1}
                  onChange={(e) => updateRow(r.id, "s1", e.target.value)}
                />
              ) : isBZ ? (
                <input
                  placeholder="Label"
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-yellow-400 outline-none focus:border-blue-500"
                  value={r.s1}
                  onChange={(e) => updateRow(r.id, "s1", e.target.value)}
                />
              ) : (
                <select
                  className="w-full appearance-none bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-blue-500 cursor-pointer"
                  value={r.s1}
                  onChange={(e) => updateRow(r.id, "s1", e.target.value)}
                >
                  {ALL_REGS.map((rg) => (
                    <option key={rg} value={rg}>
                      {rg}
                    </option>
                  ))}
                </select>
              )}

              {isLS ? (
                <select
                  className="w-full appearance-none bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-400 outline-none focus:border-blue-500 cursor-pointer"
                  value={r.s2}
                  onChange={(e) => updateRow(r.id, "s2", e.target.value)}
                >
                  {ALL_REGS.map((rg) => (
                    <option key={rg} value={rg}>
                      {rg}
                    </option>
                  ))}
                </select>
              ) : isBZ ? (
                <div></div>
              ) : isBranch ? (
                <input
                  placeholder="Label"
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-yellow-400 outline-none focus:border-blue-500"
                  value={r.s2}
                  onChange={(e) => updateRow(r.id, "s2", e.target.value)}
                />
              ) : isImm ? (
                <input
                  placeholder="#Imm"
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-green-400 outline-none focus:border-blue-500"
                  value={r.s2}
                  onChange={(e) => updateRow(r.id, "s2", e.target.value)}
                />
              ) : (
                <select
                  className="w-full appearance-none bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-blue-500 cursor-pointer"
                  value={r.s2}
                  onChange={(e) => updateRow(r.id, "s2", e.target.value)}
                >
                  <option value="#8">#8</option>
                  {ALL_REGS.map((rg) => (
                    <option key={rg} value={rg}>
                      {rg}
                    </option>
                  ))}
                </select>
              )}

              <button
                onClick={() => removeRow(r.id)}
                className="text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 flex justify-center"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

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

  const update = (path, val) => {
    const c = JSON.parse(JSON.stringify(config));
    let ref = c;
    const parts = path.split(".");
    while (parts.length > 1) ref = ref[parts.shift()];
    if (val === "") ref[parts[0]] = "";
    else ref[parts[0]] = parseInt(val) || 0;
    setConfig(c);
  };

  const updateGroupLatency = (ops, val) => {
    const c = JSON.parse(JSON.stringify(config));
    const newVal = val === "" ? "" : parseInt(val) || 0;
    ops.forEach((op) => (c.latencies[op] = newVal));
    setConfig(c);
  };

  return (
    <div className="min-h-screen bg-gray-950 p-8 font-sans text-gray-200">
      <div className="max-w-6xl mx-auto bg-gray-900 rounded-xl shadow-2xl border border-gray-800 overflow-hidden">
        <div className="bg-gray-800 p-6 flex justify-between items-center border-b border-gray-700">
          <div>
            <h1 className="text-2xl font-bold text-blue-400">
              CSEN 702: Tomasulo Simulator
            </h1>
            <p className="text-gray-400 text-sm">
              Configure architecture & Build Instruction Trace
            </p>
          </div>
          <Cpu size={40} className="text-blue-500 opacity-80" />
        </div>

        <div className="p-6 grid grid-cols-12 gap-8">
          <div className="col-span-5">
            <InstructionBuilder
              onCodeChange={setCode}
              defaultInstructions={code}
            />
            <div className="mt-2 text-xs text-gray-600 flex justify-between items-center">
              <span>Generated Assembly Preview:</span>
              <button className="text-blue-500 hover:underline flex items-center gap-1">
                <FileText size={10} /> Load File
              </button>
            </div>
            <pre className="mt-1 bg-black/50 p-2 rounded text-[10px] text-green-400 font-mono h-24 overflow-auto border border-gray-800">
              {code}
            </pre>
          </div>

          <div className="col-span-7 space-y-6 overflow-y-auto h-[500px] pr-2 custom-scrollbar">
            <div className="bg-gray-800/50 p-4 rounded-lg border border-gray-700">
              <h4 className="font-bold text-gray-400 text-xs mb-3 uppercase border-b border-gray-700 pb-2">
                Latencies
              </h4>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-[10px] font-bold text-gray-500 block uppercase">
                    Add/Sub Unit
                  </label>
                  <input
                    type="number"
                    value={config.latencies["ADD.D"]}
                    onChange={(e) =>
                      updateGroupLatency(
                        [
                          "ADD.D",
                          "SUB.D",
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
                    className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-blue-400 font-bold"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-500 block uppercase">
                    Multiplier
                  </label>
                  <input
                    type="number"
                    value={config.latencies["MUL.D"]}
                    onChange={(e) =>
                      updateGroupLatency(["MUL.D", "MUL.S"], e.target.value)
                    }
                    className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-blue-400 font-bold"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-500 block uppercase">
                    Divider
                  </label>
                  <input
                    type="number"
                    value={config.latencies["DIV.D"]}
                    onChange={(e) =>
                      updateGroupLatency(["DIV.D", "DIV.S"], e.target.value)
                    }
                    className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-blue-400 font-bold"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-500 block uppercase">
                    Load Unit
                  </label>
                  <input
                    type="number"
                    value={config.latencies["L.D"]}
                    onChange={(e) =>
                      updateGroupLatency(
                        ["L.D", "L.S", "LW", "LD"],
                        e.target.value
                      )
                    }
                    className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-blue-400 font-bold"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-500 block uppercase">
                    Store Unit
                  </label>
                  <input
                    type="number"
                    value={config.latencies["S.D"]}
                    onChange={(e) =>
                      updateGroupLatency(
                        ["S.D", "S.S", "SW", "SD"],
                        e.target.value
                      )
                    }
                    className="w-full mt-1 bg-gray-900 border border-gray-700 rounded p-2 text-blue-400 font-bold"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gray-800/50 p-4 rounded-lg border border-gray-700">
                <h4 className="font-bold text-gray-400 text-xs mb-3 uppercase border-b border-gray-700 pb-2">
                  Buffer Sizes
                </h4>
                <div className="space-y-2">
                  {["ADD", "MULT", "LOAD", "STORE"].map((t) => (
                    <div key={t} className="flex justify-between items-center">
                      <span className="text-xs text-gray-500 font-bold">
                        {t}
                      </span>
                      <input
                        type="number"
                        value={config.rsSize[t]}
                        onChange={(e) => update(`rsSize.${t}`, e.target.value)}
                        className="w-16 bg-gray-900 border border-gray-700 rounded p-1 text-center text-white"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-blue-900/10 p-4 rounded-lg border border-blue-900/30">
                <h4 className="font-bold text-blue-400 text-xs mb-3 uppercase border-b border-blue-900/30 pb-2 flex items-center gap-2">
                  <MemoryStick size={14} /> Cache
                </h4>
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-500 font-bold">
                      Size (B)
                    </span>
                    <input
                      type="number"
                      value={config.cache.size}
                      onChange={(e) => update(`cache.size`, e.target.value)}
                      className="w-16 bg-gray-900 border border-gray-700 rounded p-1 text-center text-white"
                    />
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-500 font-bold">
                      Block (B)
                    </span>
                    <input
                      type="number"
                      value={config.cache.blockSize}
                      onChange={(e) =>
                        update(`cache.blockSize`, e.target.value)
                      }
                      className="w-16 bg-gray-900 border border-gray-700 rounded p-1 text-center text-white"
                    />
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-500 font-bold">
                      Hit Lat.
                    </span>
                    <input
                      type="number"
                      value={config.cache.hitLatency}
                      onChange={(e) =>
                        update(`cache.hitLatency`, e.target.value)
                      }
                      className="w-16 bg-gray-900 border border-gray-700 rounded p-1 text-center text-white"
                    />
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-500 font-bold">
                      Miss Pen.
                    </span>
                    <input
                      type="number"
                      value={config.cache.missPenalty}
                      onChange={(e) =>
                        update(`cache.missPenalty`, e.target.value)
                      }
                      className="w-16 bg-gray-900 border border-gray-700 rounded p-1 text-center text-white"
                    />
                  </div>
                </div>
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

// ==========================================
// 5. MAIN COMPONENT (EXPORT)
// ==========================================

const TomasuloSimulator = () => {
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

      {state.modalMsg && (
        <ConflictModal
          msg={state.modalMsg}
          onClose={() => dispatch({ type: "CLOSE_MODAL" })}
        />
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* LEFT COLUMN: STATUS & CACHE */}
        <div className="flex-[3] flex flex-col p-2 gap-2 overflow-y-auto custom-scrollbar">
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

          <div className="bg-gray-900 p-3 rounded-lg shadow border border-gray-800">
            <h3 className="font-bold text-gray-400 mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider">
              <Layers size={14} /> Instruction Status
            </h3>
            <StatusTable data={state.instStatus} />
          </div>

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

          <div className="bg-gray-900 p-3 rounded-lg shadow border border-gray-800">
            <h3 className="font-bold text-gray-400 mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider">
              <MemoryStick size={14} /> Data Cache (Direct Mapped)
            </h3>
            <CacheView cache={state.cache} />
          </div>
        </div>

        {/* RIGHT COLUMN: REGISTERS & MEMORY */}
        <div className="flex-1 min-w-[300px] bg-gray-900 border-l border-gray-800 p-2 flex flex-col gap-2 h-full overflow-hidden">
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
};

export default TomasuloSimulator;
