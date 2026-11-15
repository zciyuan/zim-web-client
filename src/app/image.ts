// Browser-side image helpers (dimensions for the message payload).

export interface ImageSize {
  width: number;
  height: number;
}

/** Reads intrinsic pixel dimensions without uploading. */
export const measureImage = async (file: Blob): Promise<ImageSize> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      // fall through to the <img> path (e.g. SVG in some browsers)
    }
  }
  return new Promise<ImageSize>((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: 0, height: 0 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
};
