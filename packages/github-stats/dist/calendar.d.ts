import type { Config, Day } from "./types.js";
export declare function calendarRange(view: Config["heatmapView"], asOf: string): {
    start: string;
    end: string;
    offset: number;
};
export declare function calendarCells(view: Config["heatmapView"], asOf: string, days: Day[]): {
    cells: {
        date: string;
        requests: number;
        future: boolean;
        index: number;
    }[];
    start: string;
    end: string;
    offset: number;
};
