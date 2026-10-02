# REVLOG to WPILOG Converter

A lightweight, robust Node.js utility for converting REV Robotics binary log files (`.revlog`) into the WPILOG format (`.wpilog`).

This tool allows you to take raw CAN bus logs from REV devices (SPARK MAX, SPARK Flex, Servo Hub, detached encoders and the A301) and view them in standard FRC analysis tools like AdvantageScope.

It reads both REVLOG formats written by REVLib's `StatusLogger`:

* **Version 1**, written by REVLib 2025 through 2027.0.0-alpha-8
* **Version 2**, written by later releases

Files using a newer major version are rejected with a message to update the converter.

## Output

| REVLOG data | WPILOG entries |
| --- | --- |
| Status frame signals | Version 2: `REV/<bus>/<device>-<number>/<signal>`, for example `REV/CAN_S0/Spark-3/APPLIED_OUTPUT`. Version 1: `REV/<device>-<number>/<signal>`. Faults and warnings go in `FAULT/` and `WARNING/` subfolders |
| Firmware versions | `.../FIRMWARE` (string), written when the version changes |
| Driver Station state (version 2) | `DS:controlWord/enabled` (boolean) and `DS:controlWord/robotMode` (string). AdvantageScope uses these to line the log up with other logs and to shade enabled periods |
| Match information (version 2) | `DS:matchInfo/eventName`, `DS:matchInfo/matchType`, `DS:matchInfo/matchNumber` |
| Logger events (version 2) | `REV/StatusLogger/Event` (`started`, `capturing`, `stopped`, `resumed`, `usb-removed`, `directory-changed`) |
| Dropped frames (version 2) | `REV/StatusLogger/<bus>/DroppedFrames` (running total) |

Devices are `Spark`, `ServoHub`, `Encoder` and `A301`.

## Usage

### Command-Line Interface (CLI)

You can use `revlog-converter` as a standalone command-line tool to convert log files.

#### Installation

To use the CLI globally:

`npm install -g @rev-robotics/revlog-converter`

#### Basic Usage

Convert a file and save it to a specific output path:

`revlog-converter input.revlog -o output.wpilog`

#### Piping (Standard Input/Output)

The tool supports Unix-style piping. You can pipe a binary file into the converter and redirect the output to a file. This is useful for scripting or chaining commands.

`cat input.revlog | revlog-converter > output.wpilog`

#### Options

  * `-o, --output <file>`: Specify the output filename. If omitted (and not piping to a file), the binary data is written to `stdout`.
  * `--stats`: Print a summary of the REVLOG instead of converting it: format version, record counts and sizes, time span, frames per device, logger events, and known problems (for example timestamps from REVLib 2027 alphas, or a file that is mostly repeated firmware tables).
  * `-h, --help`: Display the help message.

`revlog-converter --stats input.revlog`

-----

### Library Usage (Node.js & TypeScript)

You can import `revlog-converter` into your own TypeScript or JavaScript projects. The library supports both **ES Modules (ESM)** and **CommonJS (CJS)**.

#### Installation

`npm install @rev-robotics/revlog-converter`

#### 1\. File-to-File Conversion

Pass file paths directly to the parser. The function handles reading and writing for you.

```typescript
import { parseREVLOG } from '@rev-robotics/revlog-converter';

async function convertFile() {
  try {
    // Reads 'match.revlog', converts it, and writes to 'match.wpilog'
    await parseREVLOG('./match.revlog', './match.wpilog');
    console.log('Conversion successful!');
  } catch (err) {
    console.error('Conversion failed:', err);
  }
}
```

#### 2\. Summarizing a REVLOG

```typescript
import { readFileSync } from 'fs';
import { analyzeREVLOG, formatStats } from '@rev-robotics/revlog-converter';

const stats = analyzeREVLOG(readFileSync('./match.revlog'));
console.log(formatStats(stats)); // or inspect stats.warnings, stats.devices, ...
```

## Development

* `npm test` runs the tests. `test/fixtures/v1-baseline.json` holds the output of converter 1.0.5 for a version 1 file; signal output for version 1 files must keep matching it.
* `npm run lint:check` and `npm run format:check` run the same checks as publishing.
