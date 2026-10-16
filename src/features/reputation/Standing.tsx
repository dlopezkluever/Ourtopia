import { useId } from 'react';
import { exchangeKindLabels, emptyExchangeHistory } from '../exchanges/model';
import { exchangeCount, incidentLabels, ruleLabel, signedPoints, standingText, type HistoryEvent, type Trust } from './model';

export function ScoreCard({ label, score, title, completed, explanation }: { label: string; score: number; title: string; completed: number; explanation: string }) {
  const id = useId();
  return <section className="score-card" aria-labelledby={id}>
    <h3 id={id}>{label}</h3>
    <p className="score-value">{standingText(score, title)}</p>
    <p className="score-count">{exchangeCount(completed)}</p>
    <details><summary>How {label} is calculated</summary><p>{explanation}</p></details>
  </section>;
}

export function TrustIndicators({ trust }: { trust: Trust }) {
  return <section className="trust-indicators" aria-label="Trust indicators">
    <h3>Trust indicators</h3>
    {trust.incidents.length === 0 ? <p>No unresolved Disputes or serious violations</p>
      : <ul>{trust.incidents.map((incident, index) => <li key={index}>{incidentLabels[incident.type]} · {incident.status}</li>)}</ul>}
  </section>;
}

export function HistoryList({ events, heading }: { events: HistoryEvent[]; heading: string }) {
  return <section className="history" aria-label={heading}>
    <h3>{heading}</h3>
    {events.length === 0 ? <p className="empty-history">{emptyExchangeHistory}</p>
      : <ol>{events.map(event => <li key={event.id}>
        <span className="history-points">{signedPoints(event.points)}</span>
        <span>{ruleLabel(event.rule)}{event.exchangeKind && ` · ${exchangeKindLabels[event.exchangeKind]}`}{event.reason && ` · ${event.reason}`}</span>
        <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleDateString()}</time>
      </li>)}</ol>}
  </section>;
}
