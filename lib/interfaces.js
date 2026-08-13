// Derives Local vs Global interface scope between two teams, per
// onboarding-framework.md part B ("location is an entity with attributes, not a
// boolean") and part A section 2 (Local vs Global Interfaces within track 2).
//
// There is no explicit interface-scope field in the Veridian data (confirmed in the
// step-1 spot check), and a team's primary_office is only an approximation of where
// its members actually sit (also confirmed - some teams are geographically mixed).
// So this compares team-level primary_office, which answers "does my team's work
// touch teams in my own office or elsewhere" - not "where does every individual sit".
// Per-employee overrides are a possible future refinement, not implemented here.

function resolveInterfaceScope(teamA, teamB) {
  if (!teamA || !teamB) {
    return { scope: 'unknown', reason: 'missing team record' };
  }

  if (teamA.team_id && teamA.team_id === teamB.team_id) {
    return { scope: 'same-team', reason: 'identical team' };
  }

  if (!teamA.primary_office || !teamB.primary_office) {
    return { scope: 'unknown', reason: 'missing primary_office on one or both teams' };
  }

  return {
    scope: teamA.primary_office === teamB.primary_office ? 'local' : 'global',
    officeA: teamA.primary_office,
    officeB: teamB.primary_office,
  };
}

module.exports = { resolveInterfaceScope };
