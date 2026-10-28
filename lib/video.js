const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = util.promisify(execFile);

/**
 * Validates and transcodes an uploaded splash video.
 * Keeps full duration, keeps audio (AAC), scales to 1080p, and enables faststart.
 */
async function processSplashVideo(inputPath, outputPath) {
    try {
        // 1. Check duration using ffprobe
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            inputPath
        ]);

        const duration = parseFloat(stdout.trim());
        
        if (isNaN(duration)) {
            throw new Error("Could not read video duration.");
        }

        // Reject only if it's ridiculously long (over 15 seconds)
        if (duration > 15.0) {
            throw new Error(`Video is too long (${duration.toFixed(1)}s). Please upload a video under 15 seconds.`);
        }

        // 2. Transcode using ffmpeg
        // NO -t flag, meaning it keeps the full duration
        // -c:v libx264: standard H.264 video codec
        // -c:a aac -b:a 128k: standard AAC audio codec, 128kbps
        // -vf scale: scale width to maintain aspect ratio, max height 1080
        // -pix_fmt yuv420p: fixes color issues on older Android devices
        // -movflags +faststart: moves metadata to front for instant streaming
        await execFileAsync('ffmpeg', [
            '-y', // overwrite output
            '-i', inputPath,
            '-vf', 'scale=-2:1080', // maintain aspect ratio, cap height at 1080
            '-c:v', 'libx264',
            '-profile:v', 'high',
            '-level', '4.0',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            outputPath
        ]);

        // 3. Clean up the raw upload
        if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
        }

        // 4. Return stats
        const stats = fs.statSync(outputPath);
        
        return {
            success: true,
            duration_ms: Math.round(duration * 1000),
            size_bytes: stats.size,
            path: outputPath
        };

    } catch (error) {
        // Clean up input file if it exists
        if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
        }
        // Clean up output file if partial
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
        throw new Error(error.message || "Video processing failed.");
    }
}

module.exports = { processSplashVideo };
