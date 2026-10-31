import { create } from "zustand";
import type { ConnState } from "../api/ws";

type ConnStore = {
  state: ConnState;
  version: string | null;
  set: (s: Partial<ConnStore>) => void;
};

export const useConnection = create<ConnStore>((set) => ({
  state: "connecting",
  version: null,
  set: (s) => set(s),
}));
