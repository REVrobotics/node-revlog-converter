#!/usr/bin/env node

import { parseREVLOG } from './lib/revlogParser.js';
import { Readable, Writable, Transform } from 'stream';
import fs from 'fs';

/**
 * Main function to run the CLI.
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  revlog-parser [inputFile] [options]
  cat <inputFile> | revlog-parser [options] > output.wpilog

Arguments:
  inputFile        The path to the input .revlog file. If omitted,
                   the tool will read from standard input (stdin).

Options:
  -o, --output     The path to the output .wpilog file.
                   If not provided, the output will be piped directly to stdout.
  -h, --help       Show this help message.
    `);
    return;
  }

  let rawStream: Readable;
  let totalBytes: number | null = null;
  let outputTarget: string | Writable | undefined = undefined;

  try {
    // --- Flexible Argument Parsing ---
    const outputFlagIndex = args.findIndex(
      (arg) => arg === '-o' || arg === '--output'
    );

    if (outputFlagIndex !== -1) {
      if (
        args.length <= outputFlagIndex + 1 ||
        args[outputFlagIndex + 1].startsWith('-')
      ) {
        console.error(
          "Error: Output flag '-o' or '--output' requires a filename."
        );
        process.exit(1);
      }
      outputTarget = args[outputFlagIndex + 1];
    } else {
      if (process.stdout.isTTY) {
        console.error(
          'Error: Refusing to write binary log data directly to the terminal.\n' +
            'Please specify an output file using "-o <filename>" or pipe/redirect the output (e.g., "> output.wpilog").'
        );
        process.exit(1);
      }
      outputTarget = process.stdout;
    }

    const nonFlagArgs = args.filter((arg, index) => {
      if (
        outputFlagIndex !== -1 &&
        (index === outputFlagIndex || index === outputFlagIndex + 1)
      ) {
        return false;
      }
      return !arg.startsWith('-');
    });

    if (nonFlagArgs.length > 1) {
      console.error('Error: Please specify only one input file.');
      process.exit(1);
    }

    // --- Determine Input Source & File Size ---
    if (nonFlagArgs.length === 1) {
      const filePath = nonFlagArgs[0];
      // Get the exact file size for the progress bar
      totalBytes = fs.statSync(filePath).size;
      rawStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    } else {
      if (process.stdin.isTTY) {
        console.error(
          'Error: No input file specified. Use --help for usage information.'
        );
        process.exit(1);
      }
      rawStream = process.stdin;
    }

    // --- Progress Bar Middleman Stream ---
    let processedBytes = 0;
    const startTime = Date.now();

    const progressTracker = new Transform({
      transform(chunk, encoding, callback) {
        processedBytes += chunk.length;

        // Only draw the progress bar if stderr is attached to a real terminal
        if (process.stderr.isTTY) {
          const elapsedSec = (Date.now() - startTime) / 1000 || 0.1;
          const speedMBps = (processedBytes / 1024 / 1024 / elapsedSec).toFixed(
            1
          );

          if (totalBytes) {
            // We know the total size (File Mode)
            const percent = Math.min(
              100,
              Math.round((processedBytes / totalBytes) * 100)
            );
            const blocks = Math.round(percent / 5); // 20 blocks total
            const bar = '█'.repeat(blocks) + '░'.repeat(20 - blocks);
            const mbDone = (processedBytes / 1024 / 1024).toFixed(1);
            const mbTotal = (totalBytes / 1024 / 1024).toFixed(1);

            // \r overwrites the current line instead of spamming new lines
            process.stderr.write(
              `\rParsing: [${bar}] ${percent}% | ${mbDone}/${mbTotal} MB | ${speedMBps} MB/s `
            );
          } else {
            // We don't know the total size (Piped Mode)
            const mbDone = (processedBytes / 1024 / 1024).toFixed(1);
            process.stderr.write(
              `\rParsing: Processed ${mbDone} MB | ${speedMBps} MB/s... `
            );
          }
        }

        // Pass the unmodified chunk down the pipe to the REVLOG parser
        this.push(chunk);
        callback();
      },
    });

    // Connect the raw input into our tracker
    rawStream.pipe(progressTracker);

    // --- Execute Parser ---
    // Pass the tracked stream to the parser instead of the raw stream
    await parseREVLOG(progressTracker, outputTarget);

    // --- Cleanup ---
    if (process.stderr.isTTY) {
      // Print a final newline so the terminal prompt doesn't overwrite our 100% bar
      process.stderr.write('\n');
    }

    if (typeof outputTarget === 'string') {
      console.error(`Successfully wrote WPILOG to "${outputTarget}"`);
    }
  } catch (error) {
    if (process.stderr.isTTY) process.stderr.write('\n'); // Break the progress line on error
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

main();
