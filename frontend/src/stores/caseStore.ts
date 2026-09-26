import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { CaseInput, CaseSlot, TypeCase } from '../types/case';
import { capacityOf } from '../types/case';
import { makeId, toPlain } from '../utils/format';
import { matrixIdsOf, slotLabel, validateCapacity } from '../utils/layout';

/** 一次调拨：某枚字模从哪个字盘的哪些格位取出 */
export interface MatrixTransfer {
  matrixId: string;
  character: string;
  fromCaseId: string;
  fromCaseCode: string;
  fromLabels: string[];
}

export interface SaveSlotsResult {
  typeCase: TypeCase;
  transfers: MatrixTransfer[];
}

interface CaseState {
  cases: TypeCase[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  createCase: (input: CaseInput) => Promise<TypeCase>;
  updateCase: (id: string, patch: Partial<TypeCase>) => Promise<void>;
  /** 保存格位布局：同一枚字模若落在别的字盘，按调拨从原字盘取出 */
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
   * 保存格位布局（调拨语义）：
   * - 同一字盘内一枚字模只能占一个格位，重复直接拒绝保存；
   * - 布局内出现的字模若还落在别的字盘，从事务内读出的原字盘取出，
   *   原字盘其他布局不动；
   * - 全部在一个 IndexedDB 事务内完成，失败时旧位置全部保留。
   * 读字盘 / 原字盘 / 字模均从事务内取唯一结果，避免并发编辑读到旧状态。
   */
  saveSlots: async (id, slots) => {
    const plainSlots = toPlain(slots);
    const nowIso = new Date().toISOString();
    let result: SaveSlotsResult;
    const changed = new Map<string, TypeCase>();
    await db.transaction('rw', db.cases, db.matrices, async () => {
      const target = await db.cases.get(id);
      if (!target) throw new Error('未找到字盘，保存已取消，原格位保留');
      const check = validateCapacity(target.rows, target.cols, plainSlots);
      if (check.overCapacity) throw new Error(check.message);

      // 同一字盘内：一枚实体字模只能落在一个格位
      const seen = new Map<string, CaseSlot>();
      for (const slot of plainSlots) {
        const prev = seen.get(slot.matrixId);
        if (prev) {
          throw new Error(
            `同一枚字模 ${slot.character}（${slot.matrixId}）已占 ${slotLabel(prev.row, prev.col)}，` +
              `不能再落到 ${slotLabel(slot.row, slot.col)}，请先取出后再保存`,
          );
        }
        seen.set(slot.matrixId, slot);
        // 字模详情必须读到唯一结果：引用了不存在的字模也拒绝
        const matrix = await db.matrices.get(slot.matrixId);
        if (!matrix) {
          throw new Error(`字模 ${slot.matrixId} 不在档案中，保存已取消，原格位保留`);
        }
        if (matrix.character !== slot.character) {
          throw new Error(
            `格位 ${slotLabel(slot.row, slot.col)} 的字符「${slot.character}」与字模 ${slot.matrixId}「${matrix.character}」不符，保存已取消`,
          );
        }
      }

      const others = await db.cases.where('id').notEqual(id).toArray();
      const incomingIds = new Set(plainSlots.map((s) => s.matrixId));
      const transfers: MatrixTransfer[] = [];
      for (const other of others) {
        const removed = other.slots.filter((s) => incomingIds.has(s.matrixId));
        if (removed.length === 0) continue;
        const kept = other.slots.filter((s) => !incomingIds.has(s.matrixId));
        const grouped = new Map<string, { character: string; labels: string[] }>();
        for (const s of removed) {
          const g = grouped.get(s.matrixId) ?? { character: s.character, labels: [] };
          g.labels.push(slotLabel(s.row, s.col));
          grouped.set(s.matrixId, g);
        }
        grouped.forEach((g, matrixId) => {
          transfers.push({
            matrixId,
            character: g.character,
            fromCaseId: other.id,
            fromCaseCode: other.code,
            fromLabels: g.labels,
          });
        });
        const nextOther: TypeCase = {
          ...other,
          slots: kept,
          matrixId: matrixIdsOf(kept),
          updatedAt: nowIso,
        };
        await db.cases.put(nextOther);
        changed.set(nextOther.id, nextOther);
      }

      const nextTarget: TypeCase = {
        ...target,
        slots: plainSlots,
        matrixId: matrixIdsOf(plainSlots),
        updatedAt: nowIso,
      };
      await db.cases.put(nextTarget);
      changed.set(nextTarget.id, nextTarget);
      result = { typeCase: nextTarget, transfers };
    });
    set((s) => ({
      cases: s.cases
        .map((c) => changed.get(c.id) ?? c)
        .sort((a, b) => (a.code < b.code ? -1 : 1)),
    }));
    return result!;
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

/**
 * 读取指定字模唯一落位：调拨保存后一枚实体字模全库至多落在一个字盘、一个格位。
 * 落在多处时返回 ambiguous，由调用方提示数据异常，避免误用第一条。
 */
export function findUniqueHolding(
  cases: TypeCase[],
  matrixId: string,
): { status: 'empty' } | { status: 'unique'; typeCase: TypeCase; slot: CaseSlot } | {
  status: 'ambiguous';
  holdings: Array<{ typeCase: TypeCase; slots: CaseSlot[] }>;
} {
  const holdings = findCaseHolding(cases, matrixId);
  if (holdings.length === 0) return { status: 'empty' };
  if (holdings.length === 1 && holdings[0].slots.length === 1) {
    return { status: 'unique', typeCase: holdings[0].typeCase, slot: holdings[0].slots[0] };
  }
  return { status: 'ambiguous', holdings };
}
