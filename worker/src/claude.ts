// worker/src/claude.ts
import type { SeedPrefs, DjTasteTrack } from './types'

export interface PersonalityResult {
  label: string    // e.g. "The Reluctant Optimist"
  roast: string    // 2-sentence witty roast
}

export interface GroupTasteResult {
  summary: string  // e.g. "This car loves 90s hip-hop and hates EDM"
  topGenre: string
  vibe: string     // e.g. "High energy, danceable"
}

interface RatingPattern {
  participantName: string
  ratingsGiven: { emoji: string; score: number; songTitle: string; artist: string }[]
  averageScore: number
}

const MODEL = 'claude-haiku-4-5-20251001'

async function callClaude(prompt: string, apiKey: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Claude API error: ${res.status} — ${body}`)
  }
  const data = await res.json<{ content: Array<{ text: string }> }>()
  return data.content[0]?.text ?? ''
}

function parseJson<T>(text: string): T {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Claude response missing JSON')
  return JSON.parse(match[0]) as T
}

export async function generatePersonality(
  pattern: RatingPattern,
  apiKey: string
): Promise<PersonalityResult> {
  const prompt = `You are generating a fun personality card for a road trip music rating game.

Participant: ${pattern.participantName}
Average score given: ${pattern.averageScore.toFixed(1)}/5
Ratings (🔥=5, ❤️=4, 😐=3, 😬=2, 💀=1):
${pattern.ratingsGiven.map(r => `- "${r.songTitle}" by ${r.artist}: ${r.emoji} (${r.score}/5)`).join('\n')}

Write a witty music personality label (3-5 words, like "The Harsh Critic" or "The Eternal Optimist") and a 2-sentence roast based on their taste. Be playful, not mean.

Respond in JSON: { "label": "...", "roast": "..." }`

  return parseJson<PersonalityResult>(await callClaude(prompt, apiKey, 200))
}

export async function generateGroupTaste(
  songs: { title: string; artist: string; averageScore: number }[],
  apiKey: string
): Promise<GroupTasteResult> {
  const sorted = [...songs].sort((a, b) => b.averageScore - a.averageScore)
  const topSongs = sorted.slice(0, 5)
  const topTitles = new Set(topSongs.map(s => s.title))
  const bottomSongs = sorted.filter(s => !topTitles.has(s.title)).slice(-3)

  const prompt = `You are summarizing a road trip group's music taste based on their ratings.

Top rated songs (the bangers):
${topSongs.map(s => `- "${s.title}" by ${s.artist} (avg ${s.averageScore.toFixed(1)}/5)`).join('\n')}

Least loved songs (the hall of shame):
${bottomSongs.map(s => `- "${s.title}" by ${s.artist} (avg ${s.averageScore.toFixed(1)}/5)`).join('\n')}

From the song titles and artists, infer the group's taste. Write a fun 1-sentence group taste summary, a best-guess top genre, and a short vibe descriptor (e.g. "High energy, danceable" or "Chill and nostalgic").

Respond in JSON: { "summary": "...", "topGenre": "...", "vibe": "..." }`

  return parseJson<GroupTasteResult>(await callClaude(prompt, apiKey, 150))
}

export interface SongPick {
  title: string
  artist: string
  reason: string   // one short line: why this fits the group right now
}

export interface RatedSongSummary {
  title: string
  artist: string
  averageScore: number
}

// The AI DJ. Picks the next batch from the seed flavours, leaning into what the
// group has rated highly and away from what flopped. Three distinct taste inputs:
//   • `seed`       — the DJ's chosen genres/decades/languages/energy (works from batch 1)
//   • `djTaste`    — a sample of the DJ's OWN Spotify favorites; surfaces their language /
//                    regional style (e.g. Hebrew) from batch 1, before any ratings exist
//   • `history`    — in-trip crowd favorites/flops (empty for the first batch)
// `djTaste` AUGMENTS the seed/ratings — it never overrides what the crowd actually likes.
// `alreadyPlayed` is the exclusion list so we never repeat.
export async function generateSongBatch(
  seed: SeedPrefs,
  history: RatedSongSummary[],
  alreadyPlayed: { title: string; artist: string }[],
  djTaste: DjTasteTrack[],
  apiKey: string,
  count = 5
): Promise<SongPick[]> {
  const liked = [...history].filter(s => s.averageScore >= 3.5).sort((a, b) => b.averageScore - a.averageScore).slice(0, 5)
  const disliked = [...history].filter(s => s.averageScore < 3).sort((a, b) => a.averageScore - b.averageScore).slice(0, 5)

  const prompt = `You are the AI DJ for a road trip music rating game. Pick the next ${count} songs to play.

Seed taste (set by the trip's DJ):
- Genres: ${seed.genres.join(', ') || 'any'}
- Decades: ${seed.decades.join(', ') || 'any'}
- Languages: ${seed.languages.join(', ') || 'any'}
- Energy (1 chill … 5 high): ${seed.energy}
${djTaste.length > 0 ? `
The DJ's own Spotify favorites (a sample of what THEY actually listen to — infer their language and regional/cultural style from this, especially non-English / local-language music like Hebrew, and let it shape your picks within the genres/decades above):
${djTaste.map(t => `- "${t.title}" by ${t.artist}`).join('\n')}
` : ''}
${history.length === 0 ? 'This is the first batch — go off the seed taste and the DJ\'s own favorites above.' : `Ratings so far (🔥=5 … 💀=1), use these to adapt:
Crowd favorites: ${liked.map(s => `"${s.title}" by ${s.artist} (${s.averageScore.toFixed(1)})`).join('; ') || 'none yet'}
Flops to avoid leaning on: ${disliked.map(s => `"${s.title}" by ${s.artist} (${s.averageScore.toFixed(1)})`).join('; ') || 'none yet'}
Lean toward the favorites' style; steer away from the flops while staying within the seed taste.`}

Do NOT repeat any of these already-played songs:
${alreadyPlayed.map(s => `- "${s.title}" by ${s.artist}`).join('\n') || '- (none yet)'}

When picking songs for a genre or decade, prefer the languages listed above and lean into the languages and regional styles evident in the DJ's own favorites and the crowd favorites — do NOT default to English if the DJ's taste is local-language (e.g. keep serving Hebrew songs to a Hebrew-listening DJ).

Return real, well-known, findable songs (exact title + primary artist as they appear on Spotify). For each, add a short one-line reason.

Respond in JSON: { "songs": [ { "title": "...", "artist": "...", "reason": "..." } ] }`

  const result = parseJson<{ songs: SongPick[] }>(await callClaude(prompt, apiKey, 700))
  return Array.isArray(result.songs) ? result.songs : []
}
