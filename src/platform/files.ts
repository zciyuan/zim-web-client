// Export/save helpers that adapt to the running shell:
//   web/PWA  -> browser download
//   PC       -> native save dialog + filesystem write
//   App      -> cache file + system share sheet

import { platform } from './detect';
import type { SaveOutcome } from './types';

const safeFileName = (name: string): string =>
  name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim() || 'zim-export.txt';

const downloadInBrowser = (name: string, text: string, mime: string): void => {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export const saveTextFile = async (fileName: string, text: string): Promise<SaveOutcome> => {
  const name = safeFileName(fileName);
  try {
    if (platform.kind === 'tauri') {
      const [{ save }, { writeTextFile }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
      ]);
      const path = await save({
        defaultPath: name,
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      });
      if (!path) return 'cancelled';
      await writeTextFile(path, text);
      return 'saved';
    }
    if (platform.mobile) {
      const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
        import('@capacitor/filesystem'),
        import('@capacitor/share'),
      ]);
      const written = await Filesystem.writeFile({
        path: `exports/${name}`,
        data: text,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      await Share.share({
        title: 'ZIM 聊天记录',
        text: `ZIM 聊天记录：${name}`,
        url: written.uri,
        dialogTitle: '导出聊天记录',
      });
      return 'shared';
    }
    downloadInBrowser(name, text, 'text/plain;charset=utf-8');
    return 'downloaded';
  } catch {
    return 'failed';
  }
};
