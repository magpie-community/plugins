export declare function scheduleFiles(platform: string, dir: string, runtime?: string, cli?: string, home?: string): {
    path: string;
    content: string;
}[];
export declare function installSchedule(dir?: string): Promise<void>;
export declare function uninstallSchedule(dir?: string): Promise<void>;
