# Workflow

Angelehnt an den im alten Harness-Repo dokumentierten Ablauf, aber mit Pi als
aktivem Implementierungsagenten statt eines externen Codex-Prozesses.

```
Requirement Spec --(Produktfreigabe: Human Gate)--> Software Spec
Software Spec --(technische Freigabe: Human Gate bei risk >= medium)--> GitHub Issue
GitHub Issue --> Pi-Implementierung (Branch, Code, Tests, Doku)
Pi-Implementierung --> Verifikation (CI, Acceptance, Review)
Verifikation --failed--> Iteration (max. 3x) --> Verifikation
Verifikation --failed nach 3x--> Human Gate (Eskalation)
Verifikation --passed--> Dokumentation
Dokumentation --> Merge (Human Gate bei risk >= medium, sonst automatisch)
Merge --> Run als 'complete' markieren
```

## Phasen (`PhaseId`)

| Phase | Bedeutung |
|---|---|
| `requirement` | Requirement Spec liegt vor und ist geprüft |
| `spec` | Software Spec liegt vor und ist geprüft |
| `issue` | GitHub Issue existiert mit passenden Labels |
| `implementation` | Branch/Code/Tests werden erstellt |
| `verification` | CI, Acceptance, Review laufen |
| `iteration` | Korrekturschleifen bei Fehlschlag |
| `documentation` | Doku wird im selben PR aktualisiert |
| `merge` | PR wird gemerged |
| `complete` | Run abgeschlossen |

## Gates (`GateType`)

| Typ | Wer löst auf | Beispiel |
|---|---|---|
| `spec` | Pi, nach Prüfung des Frontmatter-Status | Spec ist `approved` |
| `issue` | Pi, nach Prüfung der Labels | Issue hat `status:ready` + `ai:allowed` |
| `runtime` | Pi, nach Ausführung/Smoke-Test | externer Dienst reagiert wie erwartet |
| `review` | Pi, nach Prüfung offener Review-Threads | keine offenen Threads mehr |
| `merge` | Mensch bei `risk >= medium`, sonst Pi | siehe `docs/human-gates.md` |
| `human` | **immer** ein Mensch, über GitHub Issue | Produktentscheidung, Kosten, Risiko |

Iterationsgrenze: `maxAutomaticIterations` (Default 3). Danach zwingt
`computeNextAction` eine Eskalation als `human`-Gate.

## Zustandsregeln

- `advance` schaltet höchstens eine Phase weiter.
- Phasen dürfen weder übersprungen noch rückwärts gesetzt werden.
- Nicht-menschliche Gates mit `pending`, `needs-human` oder `failed`
  blockieren genauso wie offene Human-Gates.
- Ein PR wird mit Nummer und vollständigem Head-SHA an den Run gebunden.
- Ein neuer SHA desselben PR setzt bestehende Review-Evidence zurück.
- Ein anderer PR kann nicht stillschweigend an denselben Run gebunden werden.
