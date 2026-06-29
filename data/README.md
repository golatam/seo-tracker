# `data/` — per-project state

The central monitoring service stores every observed project's data here, one
directory per project id:

```
data/
└── <project-id>/
    ├── semantic-core.json     # keywords + clusters for this site (you provide)
    └── snapshots/
        ├── <date>.json        # canonical position snapshot per run
        └── reports/
            ├── <date>-weekly.md       # human weekly report
            └── <date>-positions.csv   # raw keyword delta export
```

Paths come from the project descriptor (`projects/<id>.json` → `data.corePath`
/ `data.snapshotsDir`); when omitted they default to
`data/<id>/semantic-core.json` and `data/<id>/snapshots`. Override the base
directory with the `DATA_DIR` env var.

A project with no `semantic-core.json` yet is `waiting_for_keywords`: the
runner skips it gracefully (it is not an error). Drop the semantic core in
place and flip the descriptor's `status` to `active`.

Snapshots and reports are meant to be committed — this repo is the source of
truth for position history across all projects.
