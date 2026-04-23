import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { create as createYtdl } from "youtube-dl-exec";

const youtubedl = createYtdl(
    process.env.YTDLP_PATH ||
    "C:\\Users\\kienq\\AppData\\Local\\Programs\\Python\\Python310\\Scripts\\yt-dlp.exe"
);

import type { NodeDataBase, OutputItem } from "@/lib/nodes";
import { type JobRecord } from "../queue";
import { downloadedAssetUrl, resolveDownloadDir } from "../paths/workflowAssets";
import { JobCancelledError } from "./cancellation";

type LogFn = (msg: string) => void;

/**
 * Downloads a video from a URL (YouTube, TikTok, etc.)
 * Returns the output item with the local video URL.
 */
export async function runCloneVideo(
    job: JobRecord,
    nodeData: NodeDataBase,
    url: string,
    log: LogFn
): Promise<OutputItem[]> {
    try {
        const { dir } = resolveDownloadDir(job.workflowRunId);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        // Using jobId to make the filename unique
        const filenameBase = `clone_${job.id}`;
        const outputFilePath = path.join(dir, `${filenameBase}.mp4`);

        log(`Đang chạy hệ thống tải video với URL: ${url}`);

        if (job.cancelRequested) throw new JobCancelledError();

        // youtube-dl-exec downloads the file directly to the given path.
        await youtubedl(url, {
            output: outputFilePath,
            noWarnings: true,
            format: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            mergeOutputFormat: "mp4",
            recodeVideo: "mp4",
        });

        if (job.cancelRequested) throw new JobCancelledError();

        if (!existsSync(outputFilePath)) {
            throw new Error(`Video tải về không có file .mp4 tại ${outputFilePath}.`);
        }

        const vUrl = downloadedAssetUrl(job.workflowRunId, outputFilePath);

        log(`Tải thành công: ${vUrl}`);
        return [{ videoUrl: vUrl }];
    } catch (error) {
        if (error instanceof JobCancelledError) throw error;
        throw new Error(`Lỗi tải video: ${error instanceof Error ? error.message : String(error)}`);
    }
}
