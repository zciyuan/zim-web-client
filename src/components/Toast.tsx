import { useIm } from '../app/store';

export function Toast() {
  const { toast } = useIm();
  if (!toast) return null;
  return (
    <div
      role="status"
      className={`fixed bottom-7 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-full px-4 py-2 text-sm shadow-lg ${
        toast.kind === 'error' ? 'bg-rose-600 text-white' : 'bg-slate-900 text-slate-50'
      }`}
    >
      {toast.text}
    </div>
  );
}
