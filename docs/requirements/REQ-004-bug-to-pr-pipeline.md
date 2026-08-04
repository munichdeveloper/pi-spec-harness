---
id: REQ-004
type: requirement
title: Automatisierte Bug-zu-PR-Pipeline über Issue-Typ Bug
status: review
owner: product
risk: high
created: 2026-08-04
updated: 2026-08-04
---

# REQ-004: Automatisierte Bug-zu-PR-Pipeline über Issue-Typ Bug

## Problem

Für neue Fähigkeiten durchläuft der Harness bewusst Requirement → Spec →
Issue → Implementation, bevor überhaupt Code entsteht. Für einfache
Bugfixes ist dieser Weg zu schwer: Es gibt in der Regel kein neues
Requirement, sondern nur eine Abweichung vom bereits freigegebenen
Verhalten. Aktuell muss jeder Bugfix denselben vollen Run-Prozess
durchlaufen oder wird manuell außerhalb des Harness bearbeitet — beides
erzeugt entweder unnötigen Overhead oder verliert die Nachvollziehbarkeit
und die bestehenden Merge-Gates.

Außerdem existiert bislang keine Möglichkeit, direkt auf ein neu angelegtes
Bug-Issue zu reagieren: Der Harness reagiert nur auf Label-Events an
bestehenden Tracking-Issues und auf PR-Events laufender Runs, nicht auf
`issues: opened`.

## Nutzer-Outcome

Sobald ein Issue mit GitHub-Issue-Typ `Bug` (oder hilfsweise Label
`type:bug`) angelegt wird, übernimmt eine vom Harness bereitgestellte,
wiederverwendbare GitHub-Action-Pipeline automatisch: Sie beauftragt einen
Cloud-Coding-Agent (Claude, via `claude-code-action`), der den Bug im
Repository-Kontext analysiert, nach Möglichkeit reproduziert (z. B. durch
einen fehlschlagenden Test), das Issue mit seinen Befunden anreichert, den
Fix implementiert und einen Pull Request eröffnet — in einem durchgehenden
Agent-Lauf ohne Zwischenstopp. Die bestehende PR-Verifikation (CI, sofern
konfiguriert Preview-Umgebung, Review-Threads) läuft automatisch; der
finale Merge bleibt wie bisher hinter einem risikobasierten Human-Gate. Der
Nutzer wird als Reviewer auf den entstandenen PR gesetzt.

Diese Fähigkeit steht in jedem Repository zur Verfügung, das über
`harness init` an den Harness angebunden ist, ohne dass der Workflow dort
manuell gepflegt werden muss.

## Akzeptanzkriterien

- AC-01: Ein neu angelegtes Issue mit GitHub-Issue-Typ `Bug` löst die
  Pipeline aus; hilfsweise löst auch das Label `type:bug` sie aus, falls
  Issue-Typen im Zielrepository nicht aktiv sind.
- AC-02: `harness init` installiert bzw. aktualisiert im Zielrepository eine
  minimale Referenz-Workflow-Datei, die auf einen im `pi-spec-harness`-Repo
  gepflegten wiederverwendbaren Workflow verweist (`uses:
  .../.github/workflows/bug-triage.yml@<pinned-ref>`), sodass
  Verbesserungen zentral gepflegt werden können, ohne jedes Zielrepo einzeln
  anzufassen.
- AC-03: Die Pipeline beauftragt `claude-code-action` in einer Version
  `>=1.0.94` (behebt den bekannten Trigger-Bypass über gefälschte
  Bot-Actor-Namen); ältere oder ungepinnte Versionen werden nicht
  akzeptiert.
- AC-04: Der Agent-Lauf analysiert das Issue im Repository-Kontext, versucht
  eine Reproduktion (z. B. Testfall), kommentiert das Issue mit seinen
  Befunden und fährt danach im selben Lauf mit Implementierung und
  PR-Erstellung fort.
- AC-05: Kann der Bug nicht reproduziert oder nicht eindeutig verifiziert
  werden, dokumentiert der Agent dies im Issue-Kommentar und eröffnet
  keinen PR mit ungeprüften Änderungen; stattdessen markiert er das Issue
  für menschliche Prüfung (Label `status:needs-human`).
- AC-06: Nach PR-Erstellung durch den Agent laufen bestehende
  Verifikationsmechanismen (grüne CI, aufgelöste Review-Threads, sofern
  konfiguriert Preview-E2E) unverändert weiter; der PR wird nicht
  automatisch gemerged.
- AC-07: Der Nutzer wird automatisch als Reviewer/Assignee auf den
  entstandenen PR gesetzt.
- AC-08: Ein Bug-Run erzeugt keine Requirement- oder Spec-Freigabe-Gates; er
  beginnt direkt bei einer issue-artigen Phase. Der finale Merge bleibt bei
  `risk >= medium` weiterhin hinter einem SHA-spezifischen Human-Gate.
- AC-09: Wiederholte oder doppelte Trigger-Events (z. B. Label erneut
  gesetzt) erzeugen keinen zweiten parallelen Agent-Lauf oder doppelten PR
  für dasselbe Issue.
- AC-10: Die Pipeline funktioniert identisch in jedem Repository, das den
  wiederverwendbaren Workflow referenziert, ohne repository-spezifische
  Anpassungen im Harness-Kern.

## Nicht-Ziele

- automatisches Mergen des durch den Agent erzeugten PRs,
- ein Zwei-Phasen-Checkpoint zwischen Analyse und Implementierung (bewusst
  ein durchgehender Agent-Lauf),
- Ersatz des bestehenden Requirement/Spec-gesteuerten Feature-Runs für neue
  Fähigkeiten,
- Bereitstellung von Preview-Umgebungs-Infrastruktur selbst (wird pro
  Repository vorausgesetzt, sofern vorhanden),
- Unterstützung für Coding Agents außer Claude in dieser ersten
  Ausbaustufe.
