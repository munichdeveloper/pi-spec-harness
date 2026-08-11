// Regression fixture for SPEC-008 TAC-02: content shaped like a real
// project's existing AGENTS.md (Immogent), with no pi-spec-harness markers
// yet. Exercises "insert-appended": every existing section must survive
// byte-identical, with the managed block appended at the end.
export const IMMOGENT_AGENTS_MD_FIXTURE = `# AGENTS.md

Kurzanleitung für Agenten, die an diesem Repository arbeiten.

## Quellen der Wahrheit

1. Requirement Specs unter \`docs/requirements/\` sind die fachliche Quelle
   der Wahrheit.
2. Software Specs unter \`docs/specifications/\` sind die technische Quelle
   der Wahrheit, sobald \`status: approved\` gesetzt ist.
3. Der Code selbst ist die Quelle der Wahrheit für das tatsächliche
   Verhalten -- bei Widerspruch zur Doku gewinnt getesteter Code.

## Vor jeder Implementierung

- Lies die zugehörige Spec vollständig, nicht nur die Zusammenfassung.
- Prüfe, ob bereits ein Tracking-Issue oder ein offener PR für dasselbe
  Requirement existiert.
- Kläre offene Fragen über ein Human-Gate, nicht durch Annahmen im Chat.

## Implementierung

- Ändere ausschließlich das, was die Spec beschreibt; kein unangekündigtes
  Refactoring in demselben PR.
- Halte Commits klein und nachvollziehbar.
- Aktualisiere betroffene Tests im selben PR.

## Verifikation

- \`npm run check\` muss grün sein, bevor ein PR als bereit markiert wird.
- Manuelle Verifikation gegen die Akzeptanzkriterien der Spec ist
  verpflichtend, nicht nur automatisierte Tests.

## Definition of Done

- Alle Akzeptanzkriterien der Spec sind erfüllt und verifiziert.
- Dokumentation ist aktualisiert, falls das Verhalten sich geändert hat.
- Kein offenes technisches Risiko ohne zugehöriges Human-Gate.
`;
