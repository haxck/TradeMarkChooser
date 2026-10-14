/**
 * WebMCP —— 把本页面的检索能力暴露给支持 WebMCP 的浏览器 / AI Agent。
 *
 * 规范：https://webmachinelearning.github.io/webmcp
 *   - 挂载点 `document.modelContext`
 *   - 注册方法 `document.modelContext.registerTool(tool, options)`
 *   - execute 签名 `(inputObject, { signal }) => Promise<JSON 可序列化值>`
 *   - 需 SecureContext（https 或 localhost）
 *
 * 设计原则：网站只提供「结构化检索 + 选中/导出」，不做业务推荐。
 * Agent 通过「大类 → 类似群 → 商品项」三层 + 全文检索，自行分析该选哪些类。
 */
import { store } from './store.svelte';
import { services } from './services.svelte';
import type { TrademarkClassData, TrademarkItem } from '../types/trademark';
import { buildCSV, buildJSON, buildTXT, buildXLSXBlob } from './export';

// ---------- 规范类型（依据 IDL） ----------
interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  consequentialHint?: boolean;
  debugging?: boolean;
}

interface ToolExecuteCallbackOptions {
  signal: AbortSignal;
}

interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (inputObject: any, options: ToolExecuteCallbackOptions) => Promise<unknown>;
  annotations?: ToolAnnotations;
}

interface ModelContext {
  registerTool: (tool: ModelContextTool, options?: { exposedTo?: string[]; signal?: AbortSignal }) => Promise<void>;
  getTools?: (options?: { fromOrigins?: string[] }) => Promise<unknown[]>;
  executeTool?: (tool: unknown, inputObject?: object, options?: { signal?: AbortSignal }) => Promise<string>;
}

// ---------- 辅助 ----------
async function loadAllClasses(): Promise<TrademarkClassData[]> {
  const list: TrademarkClassData[] = [];
  for (let i = 1; i <= 45; i++) {
    try {
      list.push(await services.getClassData(i));
    } catch {
      /* 忽略缺失类目 */
    }
  }
  return list;
}

function requireClassNo(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 45) throw new Error('classNo 必须是 1-45 之间的整数');
  return n;
}

// ---------- 工具定义 ----------
// 命名规则：仅 ASCII 字母数字、下划线、连字符、点号，长度 1-128。
const tools: ModelContextTool[] = [
  // ===== L1：大类概览（默认带类似群标题，供 Agent 自行分析相关性） =====
  {
    name: 'list_categories',
    title: '浏览商标大类',
    description:
      '列出全部 1-45 个商标大类。默认同时返回每个大类下所有类似群的编号与标题（如 "3503 替他人推销"），' +
      '以便据此判断哪些类别与某业务/商品相关。可将 includeGroups 设为 false 只取大类名以节省篇幅。',
    inputSchema: {
      type: 'object',
      properties: {
        includeGroups: {
          type: 'boolean',
          description: '是否返回每个大类的类似群标题概览，默认 true',
        },
        classNo: {
          type: 'number',
          description: '可选，只返回指定大类（1-45）；不传则返回全部',
        },
      },
    },
    annotations: { readOnlyHint: true },
    async execute({ includeGroups = true, classNo }: { includeGroups?: boolean; classNo?: number }) {
      const targets = classNo ? [await services.getClassData(requireClassNo(classNo))] : await loadAllClasses();
      return targets.map((c) => ({
        classNo: c.classNo,
        className: c.className,
        groupCount: c.groups.length,
        selectedCount: store.classSelectedCount(c.classNo),
        ...(includeGroups
          ? { groups: c.groups.map((g) => `${g.g} ${g.groupTitle}`) }
          : {}),
      }));
    },
  },

  // ===== L2：某大类的类似群列表 =====
  {
    name: 'list_groups',
    title: '列出某大类的类似群',
    description: '列出指定商标大类（1-45）下的所有类似群编号与标题。',
    inputSchema: {
      type: 'object',
      properties: {
        classNo: { type: 'number', description: '商标大类编号，1-45' },
      },
      required: ['classNo'],
    },
    annotations: { readOnlyHint: true },
    async execute({ classNo }: { classNo: number }) {
      const data = await services.getClassData(requireClassNo(classNo));
      return {
        classNo: data.classNo,
        className: data.className,
        groups: data.groups.map((g) => ({ g: g.g, title: g.groupTitle, itemCount: g.items.length })),
      };
    },
  },

  // ===== L3：某类似群下的商品项 =====
  {
    name: 'list_items',
    title: '列出类似群下的商品项',
    description: '列出指定大类下某个类似群（如 "3503"）中的全部商品项（编码 + 名称）。',
    inputSchema: {
      type: 'object',
      properties: {
        classNo: { type: 'number', description: '商标大类编号，1-45' },
        g: { type: 'string', description: '类似群编号，如 "3503"' },
      },
      required: ['classNo', 'g'],
    },
    annotations: { readOnlyHint: true },
    async execute({ classNo, g }: { classNo: number; g: string }) {
      const data = await services.getClassData(requireClassNo(classNo));
      const grp = data.groups.find((x) => x.g === g);
      if (!grp) throw new Error(`第 ${classNo} 类中不存在类似群 ${g}`);
      return {
        classNo: data.classNo,
        g: grp.g,
        groupTitle: grp.groupTitle,
        items: grp.items,
      };
    },
  },

  // ===== 跨层全文检索：类名 + 类似群标题 + 商品名 + 编码 =====
  {
    name: 'search',
    title: '全文检索',
    description:
      '在类名、类似群标题、商品名称、商品编码中做关键词全文检索。' +
      '可跨全部 45 类搜索，也可用 classNo 限定某个大类。返回命中的层级（类/群/商品）。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词，可匹配类名、类似群标题、商品名或六位编码' },
        classNo: { type: 'number', description: '可选，限定搜索的商标大类 1-45' },
        limit: { type: 'number', description: '可选，最多返回条数，默认 50' },
      },
      required: ['keyword'],
    },
    annotations: { readOnlyHint: true },
    async execute({ keyword, classNo, limit = 50 }: { keyword: string; classNo?: number; limit?: number }) {
      const q = String(keyword).trim().toLowerCase();
      if (!q) throw new Error('keyword 不能为空');

      const targets = classNo ? [await services.getClassData(requireClassNo(classNo))] : await loadAllClasses();
      const hits: {
        level: 'category' | 'group' | 'item';
        classNo: number;
        className: string;
        g?: string;
        groupTitle?: string;
        code?: string;
        name?: string;
      }[] = [];

      for (const c of targets) {
        if (c.className.toLowerCase().includes(q)) {
          hits.push({ level: 'category', classNo: c.classNo, className: c.className });
        }
        for (const grp of c.groups) {
          const groupText = `${grp.g} ${grp.groupTitle}`.toLowerCase();
          if (groupText.includes(q)) {
            hits.push({
              level: 'group',
              classNo: c.classNo,
              className: c.className,
              g: grp.g,
              groupTitle: grp.groupTitle,
            });
          }
          for (const it of grp.items) {
            if (it.name.toLowerCase().includes(q) || it.code.includes(q)) {
              hits.push({
                level: 'item',
                classNo: c.classNo,
                className: c.className,
                g: grp.g,
                groupTitle: grp.groupTitle,
                code: it.code,
                name: it.name,
              });
            }
          }
        }
      }

      const total = hits.length;
      return { keyword, total, returned: Math.min(total, limit), hits: hits.slice(0, limit) };
    },
  },

  // ===== 状态：查看当前已选 =====
  {
    name: 'get_selection',
    title: '查看当前已选',
    description: '返回当前已选中的全部商品项（按类别、编码排序）。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async execute() {
      return { totalSelected: store.totalSelected, items: store.selectedList };
    },
  },

  // ===== 写：加入选品（幂等） =====
  {
    name: 'add_items',
    title: '加入已选',
    description:
      '把若干商品项加入已选清单（幂等：已选中的不会重复添加，也不会取消）。传入 {classNo, code} 列表，会校验编码是否存在。',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '要加入的商品项列表',
          items: {
            type: 'object',
            properties: {
              classNo: { type: 'number' },
              code: { type: 'string', description: '六位商品编码，如 "350032"' },
            },
            required: ['classNo', 'code'],
          },
        },
      },
      required: ['items'],
    },
    annotations: { consequentialHint: true },
    async execute({ items }: { items: { classNo: number; code: string }[] }) {
      let added = 0;
      let alreadySelected = 0;
      const notFound: { classNo: number; code: string }[] = [];
      for (const req of items) {
        try {
          const data = await services.getClassData(requireClassNo(req.classNo));
          const found = data.groups.flatMap((g) => g.items).find((it) => it.code === req.code);
          if (!found) {
            notFound.push(req);
            continue;
          }
          if (store.isSelected(req.classNo, req.code)) {
            alreadySelected++;
          } else {
            // 幂等加入：直接写入选中表，不做 toggle
            store.toggleItem(req.classNo, found as TrademarkItem);
            added++;
          }
        } catch {
          notFound.push(req);
        }
      }
      return { added, alreadySelected, notFound, totalSelected: store.totalSelected };
    },
  },

  // ===== 写：移除选品 =====
  {
    name: 'remove_items',
    title: '移除已选',
    description: '从已选清单中移除若干商品项。传入 {classNo, code} 列表。',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              classNo: { type: 'number' },
              code: { type: 'string' },
            },
            required: ['classNo', 'code'],
          },
        },
      },
      required: ['items'],
    },
    annotations: { consequentialHint: true },
    async execute({ items }: { items: { classNo: number; code: string }[] }) {
      for (const it of items) store.removeItem(it.classNo, it.code);
      return { totalSelected: store.totalSelected };
    },
  },

  // ===== 写：导出（只返回元信息，不回传文件正文） =====
  {
    name: 'export_selection',
    title: '导出已选清单',
    description:
      '导出当前已选商品项并触发浏览器下载。format 可选 csv / json / txt / xlsx（xlsx 打包为 zip）。' +
      '返回值只包含文件名、条数等元信息，不含文件正文。',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['csv', 'json', 'txt', 'xlsx'] },
      },
      required: ['format'],
    },
    annotations: { readOnlyHint: true },
    async execute({ format }: { format: 'csv' | 'json' | 'txt' | 'xlsx' }) {
      if (store.totalSelected === 0) throw new Error('当前没有已选商品，无法导出');
      const itemCount = store.totalSelected;

      switch (format) {
        case 'csv': {
          const content = buildCSV();
          downloadTextFile('trademark-selected.csv', content, 'text/csv;charset=utf-8;');
          return { downloaded: true, filename: 'trademark-selected.csv', itemCount };
        }
        case 'json': {
          const content = buildJSON();
          downloadTextFile('trademark-selected.json', content, 'application/json');
          return { downloaded: true, filename: 'trademark-selected.json', itemCount };
        }
        case 'txt': {
          const content = await buildTXT();
          downloadTextFile('trademark-selected.txt', content, 'text/plain');
          return { downloaded: true, filename: 'trademark-selected.txt', itemCount };
        }
        case 'xlsx': {
          const blob = await buildXLSXBlob();
          const filename = 'trademark-selected-xlsx.zip';
          downloadBlobFile(filename, blob);
          return { downloaded: true, filename, itemCount, size: blob.size };
        }
        default:
          throw new Error(`不支持的格式：${format}`);
      }
    },
  },
];

// ---------- 下载辅助（export_selection 用；UI 侧仍走 lib/export.ts 的下载） ----------
function downloadBlobFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadTextFile(filename: string, content: string, type: string) {
  downloadBlobFile(filename, new Blob([content], { type }));
}

// ---------- 注册 ----------
export async function registerWebMCP(): Promise<boolean> {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    console.info('[WebMCP] 非安全上下文（需 https 或 localhost），已跳过注册。');
    return false;
  }

  const mcp = (document as any).modelContext as ModelContext | undefined;
  if (!mcp) {
    console.info(
      '[WebMCP] 当前浏览器不支持 document.modelContext，已跳过注册。（需开启 WebMCP 相关 flag）'
    );
    return false;
  }
  if (typeof mcp.registerTool !== 'function') {
    console.info('[WebMCP] document.modelContext 上没有 registerTool 方法，已跳过注册。');
    return false;
  }

  const results = await Promise.allSettled(tools.map((t) => mcp.registerTool(t)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[WebMCP] 工具 "${tools[i].name}" 注册失败：`, r.reason);
    }
  });

  console.info(`[WebMCP] 已注册 ${ok}/${tools.length} 个工具。`);
  return ok > 0;
}

export const webmcpTools = tools;
