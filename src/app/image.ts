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

/** Reads the duration of an audio/video blob without uploading it. */
export const measureMedia = (file: Blob, tag: "audio" | "video"): Promise<number> =>
  new Promise<number>((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement(tag);
    element.preload = "metadata";
    element.onloadedmetadata = () => {
      const seconds = Number.isFinite(element.duration) ? element.duration : 0;
      URL.revokeObjectURL(url);
      resolve(Math.round(seconds * 1000));
    };
    element.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    element.src = url;
  });

/**
 * Downscales large photos before upload: keeps the long edge within
 * `maxSide` and re-encodes as JPEG. Small images are returned untouched.
 */
export const compressImage = async (
  file: File,
  maxSide = 1600,
  quality = 0.82,
): Promise<{ file: File; compressed: boolean }> => {
  const size = await measureImage(file);
  const longEdge = Math.max(size.width, size.height);
  if (!longEdge || (longEdge <= maxSide && file.size <= 1.5 * 1024 * 1024)) {
    return { file, compressed: false };
  }
  try {
    const bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(file) : null;
    if (!bitmap) return { file, compressed: false };
    const scale = Math.min(1, maxSide / longEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return { file, compressed: false };
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), 'image/jpeg', quality);
    });
    if (!blob || blob.size >= file.size) return { file, compressed: false };
    const name = (file.name || 'image').replace(/\.(png|jpe?g|webp|gif|bmp)$/i, '') + '.jpg';
    return { file: new File([blob], name, { type: 'image/jpeg' }), compressed: true };
  } catch {
    return { file, compressed: false };
  }
};
/** Grabs a small poster frame from a video file (null when unsupported). */
export const captureVideoPoster = async (file: File): Promise<{ poster: string; duration: number } | null> => {
  if (!file.type.startsWith('video/')) return null;
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('video decode failed'));
      setTimeout(() => resolve(), 2500);
    });
    const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    if (!video.videoWidth || !video.videoHeight) return { poster: '', duration };
    const width = Math.min(320, video.videoWidth);
    const height = Math.round((video.videoHeight / video.videoWidth) * width);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(video, 0, 0, width, height);
    return { poster: canvas.toDataURL('image/jpeg', 0.6), duration };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
};