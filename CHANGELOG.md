# Changelog

## 2.0.0

- Reads REVLOG format version 2: microsecond timestamps, multiple CAN buses named in entry paths (`REV/CAN_S0/Spark-3/...`), CAN FD frame lengths, A301 firmware versions, Driver Station state (`DS:controlWord/enabled`, `DS:controlWord/robotMode`), match information (`DS:matchInfo/...`), logger events (`REV/StatusLogger/Event`) and dropped frames (`REV/StatusLogger/<bus>/DroppedFrames`)
- Rejects files with a newer major format version, with a message to update the converter
- Adds `--stats` (and `analyzeREVLOG` / `formatStats`) to summarize a REVLOG and flag known problems
- Fixes firmware versions being written on every firmware table; each `FIRMWARE` entry is now written when it changes. Logs from REVLib 2027 alphas convert to far smaller WPILOGs (277 MB to about 6 MB in one case)
- Fixes Servo Hub firmware versions (for example `25.1.2` instead of `2.1.6400`)
- Frames from non-REV manufacturers are no longer decoded with the SPARK DBC
- Decodes A301 status frames (`REV/<bus>/A301-<number>/...`) and firmware versions
- Version 1 status signals convert exactly as in 1.0.5
- Major version: new entry names for version 2 files, so AdvantageScope must update its dependency (`^1.0.5`) to pick this up

## 1.0.5

- Lower memory use, progress bar, faster conversion
