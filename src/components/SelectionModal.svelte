<script lang="ts">
  import { store } from '../lib/store.svelte';
  import { classNameOf, exportCSV, exportJSON, exportTXT, exportXLSX } from '../lib/export';

  let { closePanel }: { closePanel: () => void } = $props();

  // 按类别分组显示已选（响应式：读取 store.selected）
  function groupedSelection(): { classNo: number; items: { code: string; name: string }[] }[] {
    const map = new Map<number, { code: string; name: string }[]>();
    for (const it of store.selectedList) {
      const arr = map.get(it.classNo) ?? [];
      arr.push({ code: it.code, name: it.name });
      map.set(it.classNo, arr);
    }
    return [...map.entries()]
      .map(([classNo, items]) => ({ classNo, items }))
      .sort((a, b) => a.classNo - b.classNo);
  }
</script>

<!-- ============ 已选面板（弹窗） ============ -->
<div
  class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-20"
  role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) closePanel(); }}
  onkeydown={(e) => { if (e.key === 'Escape') closePanel(); }}
>
  <div
    class="w-full max-w-3xl border border-slate-300 bg-white"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <!-- 头部 -->
    <div class="flex items-center justify-between border-b border-slate-200 px-4 py-3">
      <h3 class="text-base font-bold text-slate-900">已选商标项目</h3>
      <div class="flex items-center gap-2">
        <span class="font-mono text-xs text-slate-500">共 {store.totalSelected} 项</span>
        <button onclick={() => closePanel()} class="border border-slate-300 px-2 py-1 text-sm text-slate-500 hover:border-slate-900 hover:text-slate-900">关闭</button>
      </div>
    </div>

    <!-- 操作栏：导出 / 清空 -->
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2">
      <div class="flex items-center gap-2 text-sm">
        <span class="text-xs text-slate-400">导出为：</span>
        <button onclick={exportXLSX} class="border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:border-slate-900 hover:text-slate-900">Zip</button>
        <button onclick={exportCSV} class="border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:border-slate-900 hover:text-slate-900">CSV</button>
        <button onclick={exportTXT} class="border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:border-slate-900 hover:text-slate-900">TXT</button>
      </div>
      <button
        onclick={() => {
          if (confirm('确认清空所有已选的商标项目？')) {
            store.clearAll();
            closePanel();
          }
        }}
        class="border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
        disabled={store.totalSelected === 0}
      >清空全部</button>
    </div>

    <!-- 列表 -->
    <div class="max-h-[50vh] overflow-y-auto">
      {#if store.totalSelected === 0}
        <div class="p-10 text-center text-sm text-slate-400">暂无已选商品</div>
      {:else}
        {#each groupedSelection() as cls}
          <div class="border-b border-slate-100">
            <div class="bg-slate-50 px-4 py-1.5 text-xs font-semibold text-slate-600">
              第 {cls.classNo} 类 · {classNameOf(cls.classNo)}
            </div>
            <table class="w-full text-sm">
              <tbody>
                {#each cls.items as item}
                  <tr class="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                    <td class="w-10 px-4 py-1.5 font-mono text-xs text-slate-400">{item.code}</td>
                    <td class="px-2 py-1.5 text-slate-800">{item.name}</td>
                    <td class="w-12 text-right pr-2">
                      <button
                        onclick={() => store.removeItem(cls.classNo, item.code)}
                        class="px-2 py-0.5 text-xs text-slate-400 hover:text-red-600"
                        title="移除"
                      >✕</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>