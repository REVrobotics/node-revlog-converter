# REVLOG to WPILOG Converter

A lightweight, robust Node.js utility for converting REV Robotics binary log files (`.revlog`) into the WPILOG format (`.wpilog`).

This tool allows you to take raw CAN bus logs from valid REV devices (Spark Max, Spark Flex, Servo Hub) and view them in standard FRC analysis tools like AdvantageScope.

## Usage

### Command-Line Interface (CLI)

You can use `revlog-converter` as a standalone command-line tool to convert log files.

#### Installation

To use the CLI globally:

`npm install -g revlog-converter`

#### Basic Usage

Convert a file and save it to a specific output path:

`revlog-converter input.revlog -o output.wpilog`

#### Piping (Standard Input/Output)

The tool supports Unix-style piping. You can pipe a binary file into the converter and redirect the output to a file. This is useful for scripting or chaining commands.

`cat input.revlog | revlog-converter > output.wpilog`

#### Options

  * `-o, --output <file>`: Specify the output filename. If omitted (and not piping to a file), the binary data is written to `stdout`.
  * `-h, --help`: Display the help message.

-----

### Library Usage (Node.js & TypeScript)

You can import `revlog-converter` into your own TypeScript or JavaScript projects. The library supports both **ES Modules (ESM)** and **CommonJS (CJS)**.

#### Installation

`npm install revlog-converter`

#### 1\. File-to-File Conversion

Pass file paths directly to the parser. The function handles reading and writing for you.

```typescript
import { parseREVLOG } from 'revlog-converter';

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

#### 2\. In-Memory Conversion (Buffers)

For advanced use cases (e.g., web servers, processing streams), you can pass a `Buffer` containing the REVLOG data. The function returns a `Promise<Buffer>` containing the generated WPILOG data.

```typescript
import { parseREVLOG } from 'revlog-converter';
import { promises as fs } from 'fs';

async function processInMemory() {
  // 1. Read file into memory (or receive from network)
  const inputBuffer = await fs.readFile('./match.revlog');

  // 2. Convert directly in memory
  // passing undefined as the second argument prevents writing to disk automatically
  const outputBuffer = await parseREVLOG(inputBuffer); 

  // 3. Do something with the output buffer (e.g., upload to cloud)
  console.log(`Generated WPILOG size: ${outputBuffer.length} bytes`);
}
```