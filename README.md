# Quotes & Bookmarks for SillyTavern

E-reader–style quotes and bookmarks for your roleplay. Highlight a memorable
line, mark it with a color (like in Yandex.Books), and revisit it later —
organized **per bot → per chat**, with your own notes attached.

## Features

- **Select-to-save.** Highlight any text inside a message → a small color
  toolbar pops up → tap a color to save it as a quote.
- **Four highlighter colors** (pink, blue, green, yellow), each with an
  optional custom meaning/label you can set in the extension settings
  (e.g. yellow = "important", pink = "cute").
- **In-chat highlighting.** Saved quotes stay highlighted right in the message
  text, like a real book highlighter. Re-applied automatically when messages
  render or you switch chats.
- **Organized by bot, then chat.** Open the panel and drill down:
  *Bots → Chats → Quotes*. Jump straight to the current chat's quotes if you
  have any.
- **Personal notes.** Write a comment on any quote.
- **Search & filter** quotes by text/note and by color.
- **Go to quote** scrolls the chat to the original spot and flashes the
  highlight.

## Usage

- Select text in a message, then pick a color from the popup.
- Open the panel via the **wand (🪄) menu → Quotes**, or the `/quotes`
  (`/bookmarks`) slash command.
- Manage color labels and toggles in **Extensions → Quotes**.

## Storage

Quotes are stored in `extensionSettings` keyed by the bot's stable identifier
(character `avatar` or `group:<id>`) and then by chat id, so you can browse
every chat of a bot from one panel.

## Notes

- Highlighting works on contiguous selections within a single message.
  Quotes that span complex formatting still save and are searchable in the
  panel even if they can't be re-highlighted inline.
