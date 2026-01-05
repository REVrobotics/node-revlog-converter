#!/usr/bin/env node

import { parseREVLOG } from './lib/revlogParser.js';

/**
 * Reads all data from the standard input stream.
 * @returns A promise that resolves with the input data as a Buffer.
 */
function readStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', (err) => reject(err));
  });
}

/**
 * Main function to run the CLI.
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  revlog-parser [inputFile] [options]
  cat <inputFile> | revlog-parser [options]

Arguments:
  inputFile        The path to the input .revlog file. If omitted,
                   the tool will read from standard input (stdin).

Options:
  -o, --output     The path to the output .wpilog file.
                   If not provided, the output will be printed to the console.
  -h, --help       Show this help message.
    `);
    return;
  }

  let inputSource: string | Buffer | undefined = undefined;
  let outputFilename: string | undefined = undefined;

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
      outputFilename = args[outputFlagIndex + 1];
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
      inputSource = await readStdin();
      if (inputSource.length === 0) {
        console.error('Error: Standard input was empty.');
        process.exit(1);
      }
    }

    const wpilogContent = await parseREVLOG(inputSource, outputFilename);

    if (outputFilename) {
      console.error(`Successfully wrote WPILOG to "${outputFilename}"`);
    } else {
      process.stdout.write(wpilogContent);
    }
  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

// Execute the main function.
main();
