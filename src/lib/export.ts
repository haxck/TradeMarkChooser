import { store } from './store.svelte';
import { services } from './services.svelte';

// ---------- 通用下载工具 ----------
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadText(filename: string, content: string, type: string) {
  downloadBlob(filename, new Blob([content], { type }));
}

// 大类的短名称（去掉 "第 N 类" 前缀）
export function classNameOf(classNo: number): string {
  const full = store.classNames[classNo] ?? '';
  const m = full.match(/^第\s*\d+\s*类\s*(.*)$/);
  return m ? m[1] : full;
}

function escapeCSV(v: string): string {
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

// ---------- JSON ----------
export function buildJSON(): string {
  const data = { exportedAt: new Date().toISOString(), items: store.selectedList };
  return JSON.stringify(data, null, 2);
}

export function exportJSON() {
  downloadText('trademark-selected.json', buildJSON(), 'application/json');
}

// ---------- CSV ----------
export function buildCSV(): string {
  const rows: string[][] = [['类别编号', '类别名称', '商品编码', '商品名称']];
  for (const it of store.selectedList) {
    rows.push([String(it.classNo), classNameOf(it.classNo), it.code, it.name]);
  }
  const csv = rows.map((r) => r.map(escapeCSV).join(',')).join('\r\n');
  return '\uFEFF' + csv; // BOM，便于 Excel 打开中文
}

export function exportCSV() {
  downloadText('trademark-selected.csv', buildCSV(), 'text/csv;charset=utf-8;');
}

// ---------- TXT ----------
export async function buildTXT(): Promise<string> {
  const lines: string[] = [];
  const seal = '─'.repeat(48);
  const classNos = [...new Set(store.selectedList.map((i) => i.classNo))].sort((a, b) => a - b);

  for (const classNo of classNos) {
    const gMap = new Map<string, string>();
    try {
      const data = await services.getClassData(classNo);
      for (const grp of data.groups) {
        for (const it of grp.items) gMap.set(it.code, grp.g);
      }
    } catch {
      /* 数据加载失败时退化为“未知小类” */
    }

    lines.push(`第 ${classNo} 类　${classNameOf(classNo)}`);
    lines.push(seal);

    const byGroup = new Map<string, { code: string; name: string }[]>();
    for (const it of store.selectedList.filter((i) => i.classNo === classNo)) {
      const g = gMap.get(it.code) ?? '未分类';
      const arr = byGroup.get(g) ?? [];
      arr.push({ code: it.code, name: it.name });
      byGroup.set(g, arr);
    }

    const sortedGroups = [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [g, items] of sortedGroups) {
      lines.push(`${g}\u3000${items.map((it) => `${it.code} ${it.name}`).join('、')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function exportTXT() {
  downloadText('trademark-selected.txt', await buildTXT(), 'text/plain');
}

// ---------- XLSX（每大类一个文件，打包成 zip） ----------
async function groupMetaOf(classNo: number): Promise<Map<string, { g: string; title: string }>> {
  const meta = new Map<string, { g: string; title: string }>();
  try {
    const data = await services.getClassData(classNo);
    for (const grp of data.groups) {
      for (const it of grp.items) meta.set(it.code, { g: grp.g, title: grp.groupTitle });
    }
  } catch {
    /* 加载失败时退回空映射 */
  }
  return meta;
}

function toUint8(out: any): Uint8Array {
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (Array.isArray(out)) return new Uint8Array(out);
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

export async function buildXLSXBlob(): Promise<Blob> {
  const XLSX = await import('xlsx');
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const list = store.selectedList;
  const classNos = [...new Set(list.map((i) => i.classNo))].sort((a, b) => a - b);

  // 汇总表
  const sumRows: (string | number)[][] = [['类别编号', '类别名称', '已选数量']];
  for (const cn of classNos) sumRows.push([cn, classNameOf(cn), store.classSelectedCount(cn)]);
  const sumWs = XLSX.utils.aoa_to_sheet(sumRows);
  const sumWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(sumWb, sumWs, '汇总');
  zip.file('汇总.xlsx', toUint8(XLSX.write(sumWb, { bookType: 'xlsx', type: 'array' })));

  // 每个大类一个 xlsx
  for (const cn of classNos) {
    const meta = await groupMetaOf(cn);
    const rows: (string | number)[][] = [['序号', '商品类别', '类似群', '商品名称']];
    let seq = 0;
    for (const it of list.filter((i) => i.classNo === cn)) {
      seq++;
      const m = meta.get(it.code);
      rows.push([seq, it.classNo, m?.g ?? '', it.name]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 6 }, { wch: 40 }, { wch: 16 }, { wch: 40 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `第${cn}类`);
    zip.file(`第${cn}类.xlsx`, toUint8(XLSX.write(wb, { bookType: 'xlsx', type: 'array' })));
  }

  return zip.generateAsync({ type: 'blob' });
}

export async function exportXLSX() {
  downloadBlob('trademark-selected-xlsx.zip', await buildXLSXBlob());
}
