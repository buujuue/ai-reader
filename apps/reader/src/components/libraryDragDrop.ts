export const LIBRARY_MATERIAL_DRAG_TYPE = 'application/x-ai-reader-material';

interface LibraryMaterialDragPayload {
  materialId: string;
}

function isLibraryMaterialDragPayload(value: unknown): value is LibraryMaterialDragPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as { materialId?: unknown; materialIds?: unknown };
  return (
    typeof candidate.materialId === 'string' &&
    candidate.materialId.length > 0 &&
    !('materialIds' in candidate)
  );
}

/** 书库树只允许一次拖动一份材料,不接受文件、文件夹或多材料载荷。 */
export function writeLibraryMaterialDragPayload(
  dataTransfer: DataTransfer,
  materialId: string,
): void {
  dataTransfer.effectAllowed = 'move';
  dataTransfer.setData(
    LIBRARY_MATERIAL_DRAG_TYPE,
    JSON.stringify({ materialId }),
  );
}

export function readLibraryMaterialDragMaterialId(
  dataTransfer: DataTransfer | null | undefined,
): string | null {
  if (!dataTransfer) return null;
  const transferTypes = dataTransfer.types ? Array.from(dataTransfer.types) : [];
  if (
    dataTransfer.files?.length > 0 ||
    transferTypes.some((type) => type.toLocaleLowerCase() === 'files')
  ) {
    return null;
  }
  const raw = dataTransfer.getData(LIBRARY_MATERIAL_DRAG_TYPE);
  if (!raw) return null;

  try {
    const payload: unknown = JSON.parse(raw);
    return isLibraryMaterialDragPayload(payload) ? payload.materialId : null;
  } catch {
    return null;
  }
}
