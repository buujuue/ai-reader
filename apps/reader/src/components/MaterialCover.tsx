import { useEffect, useRef, useState } from 'react';
import { BookMarked } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';

/** 书库列表中的封面缩略图:读取托管封面字节并以对象 URL 渲染;无封面时显示稳定占位。 */
export function MaterialCover({ materialId }: { materialId: string }) {
  const { importRepository } = useAppServices();
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void importRepository
      .readCover(materialId)
      .then((bytes) => {
        if (cancelled) return;
        if (bytes) {
          const objectUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
          objectUrlRef.current = objectUrl;
          setCoverUrl(objectUrl);
        } else {
          setCoverUrl(null);
        }
      })
      .catch(() => {
        if (!cancelled) setCoverUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [materialId, importRepository]);

  if (coverUrl) {
    return (
      <img
        src={coverUrl}
        alt=""
        aria-hidden
        className="h-9 w-7 shrink-0 rounded-sm border border-zinc-700 object-cover"
      />
    );
  }
  return (
    <div className="flex h-9 w-7 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-zinc-700 bg-zinc-800 text-xs text-zinc-400">
      <BookMarked size={14} aria-hidden />
    </div>
  );
}