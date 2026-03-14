#!/usr/bin/env node

import { parseREVLOG } from './lib/revlogParser.js';
import { Readable, Writable } from 'stream';

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

  let inputSource: string | Readable;
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
      // If no output file is provided, check if we are piping.
      // If we are attached to a terminal (TTY), refuse to dump binary.
      if (process.stdout.isTTY) {
        console.error(
          'Error: Refusing to write binary log data directly to the terminal.\n' +
            'Please specify an output file using "-o <filename>" or pipe/redirect the output (e.g., "> output.wpilog").'
        );
        process.exit(1);
      }

      // If isTTY is false, we are safely piped or redirected.
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

    // --- Determine Input Source ---
    if (nonFlagArgs.length === 1) {
      inputSource = nonFlagArgs[0];
    } else {
      if (process.stdin.isTTY) {
        console.error(
          'Error: No input file specified. Use --help for usage information.'
        );
        process.exit(1);
      }
      // Pass the stdin stream directly! No buffering.
      inputSource = process.stdin;
    }

    // Pass the streams down to the parser
    await parseREVLOG(inputSource, outputTarget);

    // Only print the success message if we wrote to a file.
    // If we piped to stdout, writing logs to the console would corrupt the binary data!
    if (typeof outputTarget === 'string') {
      console.error(`Successfully wrote WPILOG to "${outputTarget}"`);
    }
  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

// Execute the main function.
main();
