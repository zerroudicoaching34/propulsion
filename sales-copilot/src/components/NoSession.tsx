import { useEffect, useState } from "react";
import type { Screen } from "../lib/store";
import { useStore } from "../lib/store";
import { api, errorMessage, type StoredMeeting } from "../lib/api";
import { Card, Empty, formatDate } from "./ui";

export function NoSession({ target, title }: { target: Screen; title: string }) {
  const { openMeeting, notify } = useStore();
  const [meetings, setMeetings] = useState<StoredMeeting[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    Promise.all([api.meetingList(), api.prospectList()])
      .then(([m, p]) => {
        setMeetings(m.filter((x) => !x.contentPurged && (x.analysisJson || x.status !== "planned")));
        setNames(Object.fromEntries(p.map((x) => [x.id, `${x.firstName} ${x.lastName}`])));
      })
      .catch((e) => notify(errorMessage(e)));
  }, [notify]);
  return (
    <div className="mx-auto max-w-2xl p-8">
      <Card title={title}>
        {meetings.length === 0 ? (
          <Empty>Aucun rendez-vous avec un contenu disponible.</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {meetings.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2">
                <span><span className="chip mr-2 text-gold">{m.type}</span>{names[m.prospectId]} <span className="text-muted">· {formatDate(m.scheduledAt)}</span></span>
                <button className="btn btn-sm btn-gold" onClick={() => openMeeting(m.id, target)}>Ouvrir</button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
