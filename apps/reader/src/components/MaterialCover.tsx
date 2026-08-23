import { useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';

/**
 * 封面渲染:读取托管封面字节并以对象 URL 渲染。
 * - 懒加载:默认惰性,仅当封面进入视口(IntersectionObserver)才读取并按需解码,较大书库不会一次解码全部封面。
 * - 可释放:卸载时 revoke 对象 URL,避免大书库累积内存。
 * - 三态呈现:无封面(书名占位)、加载失败(封面加载失败占位)、成功(封面图)。
 * 测试环境无 IntersectionObserver 时退化为可见即加载。
 */
export function MaterialCover({
  materialId,
  title,
  lazy = true,
  className = '',
}: {
  materialId: string;
  title: string;
  lazy?: boolean;
  className?: string;
}) {
  const { importRepository } = useAppServices();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [visible, setVisible] = useState(!lazy);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // 懒加载:进入视口才标记可见,从而触发实际读取。
  useEffect(() => {
    if (!lazy || visible) return;
    const node = containerRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [lazy, visible]);

  // 可见时读取封面字节;卸载时释放对象 URL。
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setCoverUrl(null);
    void importRepository
      .readCover(materialId)
      .then((bytes) => {
        if (cancelled) return;
        setLoading(false);
        if (bytes) {
          const coverBytes = bytes.bytes.slice();
          const objectUrl = URL.createObjectURL(
            new Blob([coverBytes.buffer as ArrayBuffer], { type: bytes.mimeType }),
          );
          objectUrlRef.current = objectUrl;
          setCoverUrl(objectUrl);
        } else {
          setCoverUrl(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [visible, materialId, importRepository]);

  let content: React.ReactNode;
  if (loading) {
    content = (
      <div
        className="flex h-full w-full items-center justify-center bg-[var(--prototype-app-bg)] px-2 text-center text-zinc-500"
        role="status"
        aria-label="封面加载中"
      >
        <span className="text-[11px]">封面加载中</span>
      </div>
    );
  } else if (coverUrl && !failed) {
    content = (
      <img
        src={coverUrl}
        alt=""
        aria-hidden
        onError={() => {
          if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
          }
          setCoverUrl(null);
          setFailed(true);
        }}
        className="absolute inset-0 h-full w-full object-cover"
      />
    );
  } else if (failed) {
    content = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-zinc-500">
        <ImageOff size={16} aria-hidden />
        <span className="text-[10px]">封面加载失败</span>
      </div>
    );
  } else {
    content = (
      <div className="flex h-full w-full items-center justify-center bg-[var(--prototype-app-bg)] px-2 text-center text-[var(--prototype-text)]">
        <span className="line-clamp-5 break-words text-[11px] font-medium leading-4">
          {title}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      aria-label={`${title} 封面`}
      data-cover-state={loading ? 'loading' : failed ? 'failed' : coverUrl ? 'ready' : 'placeholder'}
      className={`relative aspect-[3/4] w-full overflow-hidden rounded-md border border-[var(--prototype-border)] bg-[var(--prototype-app-bg)] ${className}`}
    >
      {content}
    </div>
  );
}
