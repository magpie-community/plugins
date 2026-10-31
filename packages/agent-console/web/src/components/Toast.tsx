// Toast notifications (global store + component).
import { create } from "zustand";

type ToastStore = {
  list: { id: number; text: string; err?: boolean }[];
  push(text: string, err?: boolean): void;
};
let nid = 0;
export const useToasts = create<ToastStore>((set) => ({
  list: [],
  push: (text, err) => {
    const id = ++nid;
    set((s) => ({ list: [...s.list, { id, text, err }] }));
    setTimeout(() => set((s) => ({ list: s.list.filter((t) => t.id !== id) })), 3500);
  },
}));
export const toast = (text: string, err = false) => useToasts.getState().push(text, err);

export function Toasts() {
  const list = useToasts((s) => s.list);
  if (list.length === 0) return null;
  return (
    <div className="toasts">
      {list.map((t) => <div key={t.id} className={`toast${t.err ? " err" : ""}`}>{t.text}</div>)}
    </div>
  );
}
