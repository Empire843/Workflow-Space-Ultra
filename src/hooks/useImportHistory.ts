import { useEffect, useState } from "react";
import type { GenMode } from "@/lib/nodes";

export interface ImportHistoryData {
    imagePrompts: string;
    videoPrompts: string;
    scriptPrompts?: string;
    imageGenMode: GenMode;
    videoGenMode: GenMode;
    aspectRatio: "16:9" | "9:16" | "1:1";
    groupInFrame: boolean;
    imageOnly: boolean;
    stylePrefix?: string;
}

export interface ImportHistoryEntry {
    id: string;
    timestamp: number;
    label: string;
    data: ImportHistoryData;
}

const STORAGE_KEY = "wsu_import_history";

export function useImportHistory() {
    const [history, setHistory] = useState<ImportHistoryEntry[]>([]);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                setHistory(JSON.parse(stored));
            }
        } catch (e) {
            console.error("Failed to load import history", e);
        }
        setLoaded(true);
    }, []);

    const saveHistory = (data: ImportHistoryData, label?: string) => {
        const entry: ImportHistoryEntry = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            timestamp: Date.now(),
            label: label || `Import ${new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
            data,
        };

        const next = [entry, ...history].slice(0, 30); // Keep max 30 entries
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch (e) {
            console.error("Failed to save import history", e);
        }
        setHistory(next);
    };

    const deleteHistory = (id: string) => {
        const next = history.filter((h) => h.id !== id);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch (e) {
            console.error("Failed to save import history", e);
        }
        setHistory(next);
    };

    const clearHistory = () => {
        setHistory([]);
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) {
            console.error("Failed to clear import history", e);
        }
    };

    return { history, loaded, saveHistory, deleteHistory, clearHistory };
}
