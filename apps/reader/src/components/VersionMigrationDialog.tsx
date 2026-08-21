import { useEffect, useState } from 'react';
import { AlertTriangle, Check, RotateCcw, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { VersionMigrationPreviewItem } from '../domain/library/versionMigration';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';

function shortFingerprint(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
}

function outcomeLabel(outcome: VersionMigrationPreviewItem['outcome']): string {
  if (outcome === 'kept') return '保持';
  if (outcome === 'reanchored') return '唯一重锚';
  return '孤儿';
}

function outcomeClass(outcome: VersionMigrationPreviewItem['outcome']): string {
  if (outcome === 'kept') return 'text-emerald-300';
  if (outcome === 'reanchored') return 'text-sky-300';
  return 'text-amber-300';
}

function reasonLabel(item: VersionMigrationPreviewItem): string {
  if (item.reason === 'multiple-matches') return `找到 ${item.matchCount} 个匹配`;
  if (item.reason === 'zero-matches') return '没有找到匹配';
  if (item.reason === 'context-mismatch') return '上下文不匹配';
  if (item.reason === 'search-error') return '搜索失败，未自动附着';
  if (item.reason === 'unresolvable-position') return '原位置无法在新版本解析';
  return item.matchCount > 1 ? `找到 ${item.matchCount} 个匹配` : '';
}

function PreviewItems(props: { title: string; items: VersionMigrationPreviewItem[] }) {
  if (props.items.length === 0) return null;
  return (
    <section className="mb-3">
      <h3 className="mb-1 text-xs font-semibold text-zinc-300">{props.title}</h3>
      <div className="max-h-36 overflow-y-auto rounded border border-zinc-800">
        {props.items.map((item) => (
          <div
            key={item.id}
            className="flex items-start justify-between gap-3 border-b border-zinc-800 px-2 py-1.5 text-xs last:border-b-0"
          >
            <span className="min-w-0 truncate text-zinc-400">{item.label}</span>
            <span className={`shrink-0 ${outcomeClass(item.outcome)}`}>
              {outcomeLabel(item.outcome)}
              {reasonLabel(item) ? ` · ${reasonLabel(item)}` : ''}
              {item.deleted ? ' · 已删除' : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MigrationCandidateDialog() {
  const { commands } = useAppServices();
  const candidates = useShellUiStore((state) => state.versionMigrationCandidates);
  const preview = useShellUiStore((state) => state.versionMigrationPreview);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSelectedIndex(0);
  }, [candidates.length]);

  useEffect(() => {
    if (candidates.length === 0 && !preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      void commands.execute(COMMAND_IDS.libraryCancelVersionMigration).catch(console.error);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, candidates.length, commands, preview]);

  if (candidates.length === 0 && !preview) return null;

  const selected = candidates[selectedIndex] ?? candidates[0] ?? preview?.candidate;
  if (!selected) return null;

  const run = async (commandId: Parameters<typeof commands.execute>[0], ...args: unknown[]) => {
    setBusy(true);
    try {
      await commands.execute(commandId, ...args);
    } catch (error) {
      console.error('版本迁移操作失败', error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="确认 EPUB 版本迁移"
    >
      <div className="w-full max-w-2xl rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">发现 EPUB 新版本</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              元数据相同但完整内容指纹不同。请选择旧材料并预览迁移结果；应用不会自动合并。
            </p>
          </div>
          <button
            type="button"
            aria-label="取消版本迁移"
            disabled={busy}
            onClick={() => void run(COMMAND_IDS.libraryCancelVersionMigration)}
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {!preview ? (
          <>
            {candidates.length > 1 ? (
              <div className="mb-4 rounded border border-zinc-800 p-2">
                <p className="mb-2 text-xs text-zinc-500">匹配到多个旧材料，请选择迁移目标：</p>
                <div className="flex flex-col gap-1">
                  {candidates.map((candidate, index) => (
                    <button
                      type="button"
                      key={candidate.material.id}
                      onClick={() => setSelectedIndex(index)}
                      className={`rounded px-2 py-1.5 text-left text-xs ${
                        index === selectedIndex
                          ? 'bg-sky-900/50 text-sky-200'
                          : 'text-zinc-400 hover:bg-zinc-800'
                      }`}
                    >
                      {candidate.material.title} · {shortFingerprint(candidate.material.fingerprint)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mb-4 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2">
              <div className="rounded border border-zinc-800 p-3">
                <p className="mb-1 text-zinc-500">旧材料</p>
                <p className="text-zinc-200">{selected.material.title}</p>
                <p className="mt-1 font-mono">{shortFingerprint(selected.material.fingerprint)}</p>
              </div>
              <div className="rounded border border-zinc-800 p-3">
                <p className="mb-1 text-zinc-500">待导入新版本</p>
                <p className="text-zinc-200">{selected.metadata.title}</p>
                <p className="mt-1 font-mono">{shortFingerprint(selected.staged.fingerprint)}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(COMMAND_IDS.libraryCancelVersionMigration)}
                className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                取消并保留旧版本
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(COMMAND_IDS.libraryPreviewVersionMigration, selected)}
                className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                预览迁移
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-4 flex items-start gap-2 rounded border border-amber-700/60 bg-amber-950/30 p-3 text-xs leading-5 text-amber-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
              <p>
                只有同一章节内的唯一精确引文会自动重锚。零匹配、多匹配或跨章节匹配都会保留为孤儿批注，等待你后续处理。
              </p>
            </div>
            <div className="mb-4 grid grid-cols-4 gap-2 text-center text-xs">
              <div className="rounded border border-zinc-800 p-2 text-emerald-300">
                <strong className="block text-base">{preview.summary.kept}</strong>保持
              </div>
              <div className="rounded border border-zinc-800 p-2 text-sky-300">
                <strong className="block text-base">{preview.summary.reanchored}</strong>唯一重锚
              </div>
              <div className="rounded border border-zinc-800 p-2 text-amber-300">
                <strong className="block text-base">{preview.summary.orphaned}</strong>孤儿
              </div>
              <div className="rounded border border-zinc-800 p-2 text-zinc-300">
                <strong className="block text-base">{preview.summary.total}</strong>总项目
              </div>
            </div>
            <PreviewItems title="阅读进度" items={preview.progress} />
            <PreviewItems title="批注" items={preview.annotations} />
            <div className="flex justify-between gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => useShellUiStore.getState().setVersionMigrationPreview(null)}
                className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                返回选择
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(COMMAND_IDS.libraryCommitVersionMigration, preview)}
                className="flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <Check size={15} aria-hidden />
                确认迁移并保留恢复快照
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MigrationSnapshotsDialog() {
  const { commands } = useAppServices();
  const snapshots = useShellUiStore((state) => state.versionMigrationSnapshots);
  const open = useShellUiStore((state) => state.versionMigrationSnapshotDialogOpen);
  const close = useShellUiStore((state) => state.closeVersionMigrationSnapshots);
  const materials = useLibraryStore((state) => state.materials);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busyId === null) close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busyId, close, open]);

  if (!open) return null;

  const run = async (id: string, command: 'restore' | 'clear') => {
    setBusyId(id);
    try {
      await commands.execute(
        command === 'restore'
          ? COMMAND_IDS.libraryRestoreVersionMigrationSnapshot
          : COMMAND_IDS.libraryClearVersionMigrationSnapshot,
        id,
      );
      if (command === 'restore') close();
    } catch (error) {
      console.error('迁移快照操作失败', error);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="版本迁移恢复快照">
      <div className="w-full max-w-xl rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">版本迁移恢复快照</h2>
            <p className="mt-1 text-xs text-zinc-500">快照不会自动清除，只有明确清除后才会删除。</p>
          </div>
          <button type="button" onClick={close} aria-label="关闭" className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
            <X size={16} aria-hidden />
          </button>
        </div>
        {snapshots.length === 0 ? (
          <p className="py-5 text-center text-sm text-zinc-500">当前没有恢复快照。</p>
        ) : (
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {snapshots.map((snapshot) => {
              const material = materials.find((item) => item.id === snapshot.materialId);
              const busy = busyId === snapshot.id;
              return (
                <div key={snapshot.id} className="flex items-center justify-between gap-3 rounded border border-zinc-800 p-3">
                  <div className="min-w-0 text-xs">
                    <p className="truncate text-zinc-200">{material?.title ?? snapshot.materialId}</p>
                    <p className="mt-1 text-zinc-500">
                      {snapshot.status === 'available' ? '可恢复' : '损坏'} · {new Date(snapshot.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button type="button" disabled={busy || snapshot.status !== 'available'} onClick={() => void run(snapshot.id, 'restore')} className="flex items-center gap-1 rounded border border-sky-700 px-2 py-1.5 text-xs text-sky-300 hover:bg-sky-950 disabled:opacity-50">
                      <RotateCcw size={13} aria-hidden /> 恢复
                    </button>
                    <button type="button" disabled={busy} onClick={() => void run(snapshot.id, 'clear')} className="rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50">
                      清除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function VersionMigrationDialog() {
  return (
    <>
      <MigrationCandidateDialog />
      <MigrationSnapshotsDialog />
    </>
  );
}
