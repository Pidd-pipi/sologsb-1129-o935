import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { CaseInput, CaseSlot, TypeCase } from '../types/case';
import { capacityOf } from '../types/case';
import { makeId, toPlain } from '../utils/format';
import { findDuplicateMatrix, matrixIdsOf, slotLabel, validateCapacity } from '../utils/layout';

/** 一笔跨字盘调拨：字模从原字盘的格位被取出、落入当前编辑字盘 */
export interface SlotTransfer {
  /** 原字盘 */
  fromCase: TypeCase;
  matrixId: string;
  character: string;
  /** 在原字盘中被取出的格位标签 */
  positions: string[];
}

export interface SaveSlotsResult {
  typeCase: TypeCase;
  /** 本次保存触发的跨字盘调拨（为空表示仅在本字盘内变动） */
  transfers: SlotTransfer[];
}

interface CaseState {
  cases: TypeCase[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  createCase: (input: CaseInput) => Promise<TypeCase>;
  updateCase: (id: string, patch: Partial<TypeCase>) => Promise<void>;
  saveSlots: (id: string, slots: CaseSlot[]) => Promise<SaveSlotsResult>;
  removeCase: (id: string) => Promise<void>;
}

export const useCaseStore = create<CaseState>((set, get) => ({
  cases: [],
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const cases = await db.cases.toArray();
      set({ cases: cases.sort((a, b) => (a.code < b.code ? -1 : 1)), loaded: true, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '字盘档案读取失败' });
    }
  },

  createCase: async (input) => {
    const now = new Date().toISOString();
    const rows = Number(input.rows);
    const cols = Number(input.cols);
    const row: TypeCase = toPlain({
      id: makeId('case'),
      code: input.code.trim(),
      kind: input.kind,
      rows,
      cols,
      slots: [] as CaseSlot[],
      workStation: input.workStation.trim(),
      matrixId: [] as string[],
      createdAt: now,
      updatedAt: now,
    });
    if (capacityOf(rows, cols) <= 0) throw new Error('字盘容量不合法，请检查行列数');
    await db.cases.add(row);
    set((s) => ({ cases: [...s.cases, row].sort((a, b) => (a.code < b.code ? -1 : 1)) }));
    return row;
  },

  updateCase: async (id, patch) => {
    const plain = toPlain(patch);
    const next: Partial<TypeCase> = { ...plain, updatedAt: new Date().toISOString() };
    if (plain.rows || plain.cols) {
      const current = get().cases.find((c) => c.id === id);
      const rows = plain.rows ?? current?.rows ?? 0;
      const cols = plain.cols ?? current?.cols ?? 0;
      const slots = plain.slots ?? current?.slots ?? [];
      const check = validateCapacity(rows, cols, slots);
      if (check.overCapacity) throw new Error(check.message);
    }
    await db.cases.update(id, next);
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, ...next } : c)) }));
  },

  /**
   * 保存格位布局（按调拨处理）：
   * 1. 容量校验；同一枚字模在同一字盘重复落位则拒绝保存（带已占用格位说明）。
   * 2. 同一事务内：写入当前字盘新布局，并把其中每枚字模从其它字盘的对应格位取出，
   *    其它字盘的其余布局不变。任一步失败整笔回滚，原位置仍然保留。
   * 3. 事务提交后一次性刷新内存，当前字盘 / 原字盘 / 字模反查均得到唯一结果。
   */
  saveSlots: async (id, slots) => {
    const current = get().cases.find((c) => c.id === id);
    if (!current) throw new Error('未找到字盘');
    const check = validateCapacity(current.rows, current.cols, slots);
    if (check.overCapacity) throw new Error(check.message);
    const duplicate = findDuplicateMatrix(slots);
    if (duplicate) {
      throw new Error(
        `「${duplicate.character}」（${duplicate.matrixId}）在本字盘已占用 ${duplicate.positions.join('、')}，同一枚字模不能重复落位`,
      );
    }
    const incoming = toPlain(slots) as CaseSlot[];
    const incomingIds = new Set(matrixIdsOf(incoming));
    const stamp = new Date().toISOString();

    // 事务内以库中最新字盘为准计算调拨，保证跨字盘唯一；失败时 IndexedDB 整体回滚
    const result = await db.transaction('rw', db.cases, async () => {
      const freshCurrent = await db.cases.get(id);
      if (!freshCurrent) throw new Error('未找到字盘');
      const freshCheck = validateCapacity(freshCurrent.rows, freshCurrent.cols, incoming);
      if (freshCheck.overCapacity) throw new Error(freshCheck.message);

      const others = (await db.cases.toArray()).filter((c) => c.id !== id);
      const updates = new Map<string, TypeCase>();
      const transfers: SlotTransfer[] = [];
      for (const other of others) {
        if (!other.slots.some((s) => incomingIds.has(s.matrixId))) continue;
        const removed = other.slots.filter((s) => incomingIds.has(s.matrixId));
        const keptSlots = other.slots.filter((s) => !incomingIds.has(s.matrixId));
        const nextOther: TypeCase = {
          ...other,
          slots: keptSlots,
          matrixId: matrixIdsOf(keptSlots),
          updatedAt: stamp,
        };
        updates.set(other.id, nextOther);
        const byMatrix = new Map<string, { character: string; positions: string[] }>();
        for (const s of removed) {
          const g = byMatrix.get(s.matrixId) ?? { character: s.character, positions: [] };
          g.positions.push(slotLabel(s.row, s.col));
          byMatrix.set(s.matrixId, g);
        }
        byMatrix.forEach((g, matrixId) => {
          transfers.push({ fromCase: other, matrixId, character: g.character, positions: g.positions });
        });
      }

      const saved: TypeCase = {
        ...freshCurrent,
        slots: incoming,
        matrixId: matrixIdsOf(incoming),
        updatedAt: stamp,
      };
      await db.cases.put(saved);
      await Promise.all([...updates.values()].map((c) => db.cases.put(c)));
      return { saved, updates, transfers: transfers.sort((a, b) => a.fromCase.code.localeCompare(b.fromCase.code)) };
    });

    // 提交成功后统一更新内存（失败已在上方抛出，store 状态维持原样）
    set((s) => ({
      cases: s.cases
        .map((c) => (c.id === result.saved.id ? result.saved : (result.updates.get(c.id) ?? c)))
        .sort((a, b) => (a.code < b.code ? -1 : 1)),
    }));
    return { typeCase: result.saved, transfers: result.transfers };
  },

  removeCase: async (id) => {
    await db.cases.delete(id);
    set((s) => ({ cases: s.cases.filter((c) => c.id !== id) }));
  },
}));

/** 找出存放指定字模的字盘与格位 */
export function findCaseHolding(cases: TypeCase[], matrixId: string): Array<{ typeCase: TypeCase; slots: CaseSlot[] }> {
  const out: Array<{ typeCase: TypeCase; slots: CaseSlot[] }> = [];
  for (const c of cases) {
    const slots = c.slots.filter((s) => s.matrixId === matrixId);
    if (slots.length) out.push({ typeCase: c, slots });
  }
  return out;
}
