import TelegramBot from 'node-telegram-bot-api'
import { promises as fs } from 'fs'
import fsSync from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import axios from 'axios'
import sharp from 'sharp'
import mime from 'mime-types'
import ffmpeg from 'fluent-ffmpeg'
import { Sticker, StickerTypes } from 'wa-sticker-formatter'
import { downloadContentFromMessage } from 'baileys'
import { Config } from '@neoxr/wb'
import colors from 'colors'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function msgTime() {
   const d = new Date()
   const p = n => String(n).padStart(2, '0')
   return `${p(d.getDate())}/${p(d.getMonth()+1)}/${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtBytes(str) {
   const bytes = str ? Buffer.byteLength(String(str), 'utf8') : 0
   if (bytes === 0) return '0B'
   const units = ['B', 'KB', 'MB', 'GB']
   const i = Math.floor(Math.log(bytes) / Math.log(1024))
   return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + units[i]
}

function msgLog(type, phone, name, chat, textContent) {
   console.log(
      colors.bgGreen(' BRIDGE '),
      msgTime(),
      colors.bgGreen(` ${type} `),
      'from',
      `[${phone}]`,
      colors.bgYellow.black(` ${name} `),
      'in',
      colors.cyan(`[${chat}]`)
   )
   if (textContent) console.log(textContent)
}

const logger = {
   info:  (...a) => console.log(colors.bgGreen(' BRIDGE '),  msgTime(), ...a),
   warn:  (...a) => console.warn(colors.bgYellow(' BRIDGE '), msgTime(), ...a),
   error: (...a) => console.error(colors.bgRed(' BRIDGE '),  msgTime(), ...a),
   debug: () => {},
}

function resolveLid(sock, jid, participants = [], altJid = null) {
   if (!jid) return jid
   if (!jid.endsWith('@lid')) return jid

   // 0) WhatsApp supplies the PN counterpart for THIS message directly on the key
   //    (remoteJidAlt for DMs, participantAlt for groups/participants) since Baileys 6.8+.
   //    This is the most authoritative source — it's delivered per-message by WhatsApp
   //    itself and doesn't depend on any store/cache having already learned this contact,
   //    which is exactly why self-sent / first-contact messages resolve here when nothing
   //    else can.
   if (altJid && !altJid.endsWith('@lid')) return altJid

   // 1) Core's own canonical jid<->lid map (global.db.users), built by handler.js via
   //    client.getRealJid()/client.getUserId() as the core bot processes messages.
   try {
      const known = global.db?.users?.find(u => u.lid === jid)
      if (known?.jid && !known.jid.endsWith('@lid')) return known.jid
   } catch {}

   // 2) Ask Baileys directly (works once the LID<->PN mapping store has synced this contact).
   if (sock?.getRealJid) {
      const real = sock.getRealJid(jid)
      if (real && !real.endsWith('@lid')) return real
   }

   // 3) Group participants list (group chats only).
   const found = participants.find(p => p.lid === jid || p.id === jid)
   if (found?.phoneNumber) return found.phoneNumber
   if (found?.id && !found.id.endsWith('@lid')) return found.id
   return jid
}

class TelegramCommands {
   constructor(bridge) {
      this.bridge = bridge
      this.paginationState = new Map()
      
      this.waitingForRestore = new Map()
   }

   sanitizeOutput(text) {
      if (!text) return ''
      return text.replace(/```/g, '`\\`\\``').replace(/`/g, '\\`')
   }

   formatBytes(bytes) {
      const sizes = ['Bytes', 'KB', 'MB', 'GB']
      if (bytes === 0) return '0 Bytes'
      const i = Math.floor(Math.log(bytes) / Math.log(1024))
      return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i]
   }

   async handleCommand(msg) {
      const text = msg.text
      if (!text || !text.startsWith('/')) return

      const [command, ...args] = text.trim().split(/\s+/)
      const userId = msg.from.id

      if (command.toLowerCase() === '/password') {
         await this.handlePassword(msg.chat.id, args)
         return
      }

      if (!this.bridge.isUserAuthenticated(userId)) {
         await this.bridge.telegramBot.sendMessage(msg.chat.id, '🔒 <b>Access Denied</b>\n\nPlease authenticate first:\n<code>/password &lt;your_password&gt;</code>', { parse_mode: 'HTML' })
         return
      }

      try {
         switch (command.toLowerCase()) {
            case '/start':         await this.handleStart(msg.chat.id); break
            case '/tools':         await this.handleTools(msg.chat.id); break
            case '/status':        await this.handleStatus(msg.chat.id); break
            case '/send':          await this.handleSend(msg.chat.id, args); break
            case '/contacts':      await this.handleContacts(msg.chat.id, args[0] ? parseInt(args[0]) - 1 : 0); break
            case '/searchcontact': await this.handleSearchContact(msg.chat.id, args); break
            case '/addfilter':     await this.handleAddFilter(msg.chat.id, args); break
            case '/filters':       await this.handleListFilters(msg.chat.id); break
            case '/clearfilters':  await this.handleClearFilters(msg.chat.id); break
            case '/backup':        await this.handleBackup(msg.chat.id); break
            case '/restore':       await this.handleRestore(msg.chat.id, msg); break
            case '/updatetopics':  await this.handleUpdateTopics(msg.chat.id); break
            case '/restart':       await this.handleRestart(msg.chat.id); break
            case '/updatebot':     await this.handleUpdateBot(msg.chat.id); break
            case '/joingroup':     await this.handleJoinGroup(msg.chat.id, args); break
            case '/listgroups':    await this.handleListGroups(msg.chat.id, args[0] ? parseInt(args[0]) - 1 : 0); break
            default:               await this.handleMenu(msg.chat.id)
         }
      } catch (error) {
         logger.error(`Error handling command ${command}:`, error)
         await this.bridge.telegramBot.sendMessage(msg.chat.id, `❌ <b>Command error</b>\n<code>${this.sanitizeOutput(error.message)}</code>`, { parse_mode: 'HTML' })
      }
   }

   async handleStart(chatId) {
      try {
         const uptimeMs = process.uptime() * 1000
         const startTime = new Date(Date.now() - uptimeMs)
         const formatUptime = (ms) => {
            const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24)
            if (d > 0) return `${d}d ${h % 24}h ${m % 60}m ${s % 60}s`
            if (h > 0) return `${h % 24}h ${m % 60}m ${s % 60}s`
            if (m > 0) return `${m % 60}m ${s % 60}s`
            return `${s % 60}s`
         }
         const formatDate = (date) => {
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
            const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
            return `${String(date.getDate()).padStart(2,'0')} ${months[date.getMonth()]} ${date.getFullYear()} ${days[date.getDay()]} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
         }
         const keyboard = { inline_keyboard: [[{ text: '🛠 Tools', callback_data: 'start_tools' }]] }
         await this.bridge.telegramBot.sendMessage(chatId,
            `*WhatsApp Bridge*\n\nStatus: Running\nUp since: ${formatDate(startTime)} (${formatUptime(uptimeMs)})`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
         )
      } catch {
         await this.bridge.telegramBot.sendMessage(chatId, '*WhatsApp Bridge*\n\nStatus: Running', { parse_mode: 'Markdown' })
      }
   }

   async handleStatus(chatId) {
      try {
         const whatsapp = this.bridge.whatsappClient
         const userName = whatsapp?.user?.name || 'Unknown'
         const memUsage = process.memoryUsage()
         const uptimeSeconds = process.uptime()
         const formatBytes = (b) => { const s = ['B','KB','MB','GB']; if (!b) return '0 B'; const i = Math.floor(Math.log(b)/Math.log(1024)); return (b/Math.pow(1024,i)).toFixed(i===0?0:1)+' '+s[i] }
         const formatUptime = (s) => { const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60); if(d>0) return `${d}d ${h}h ${m}m ${sec}s`; if(h>0) return `${h}h ${m}m ${sec}s`; if(m>0) return `${m}m ${sec}s`; return `${sec}s` }
         const os = (await import('os')).default
         const load = os.loadavg()
         const waStatus  = whatsapp ? '🟢 Connected' : '🔴 Disconnected'
         const brStatus  = this.bridge.config?.telegram?.enabled ? '🟢 Enabled' : '🔴 Disabled'
         const memPct    = Math.round(memUsage.heapUsed / memUsage.heapTotal * 100)
         const memBar    = '█'.repeat(Math.round(memPct/10)) + '░'.repeat(10 - Math.round(memPct/10))
         const status =
            `<b>📊 Bridge Status</b>\n` +
            `<code>━━━━━━━━━━━━━━━━━━━━</code>\n\n` +
            `<b>🔌 Connection</b>\n` +
            `├ WhatsApp: ${waStatus}\n` +
            `├ Account: <b>${userName}</b>\n` +
            `└ Bridge: ${brStatus}\n\n` +
            `<b>📈 Mappings</b>\n` +
            `├ 💬 Chats: <code>${this.bridge.chatMappings?.size || 0}</code>\n` +
            `├ 👥 Users: <code>${this.bridge.userMappings?.size || 0}</code>\n` +
            `├ 📒 Contacts: <code>${this.bridge.contactMappings?.size || 0}</code>\n` +
            `└ 🚫 Filters: <code>${this.bridge.filters?.size || 0}</code>\n\n` +
            `<b>⚙️ Runtime</b>\n` +
            `├ Node.js: <code>${process.version}</code>\n` +
            `├ Uptime: <code>${formatUptime(uptimeSeconds)}</code>\n` +
            `└ Load avg: <code>${load[0].toFixed(2)} / ${load[1].toFixed(2)} / ${load[2].toFixed(2)}</code>\n\n` +
            `<b>💾 Memory</b>\n` +
            `├ <code>[${memBar}] ${memPct}%</code>\n` +
            `├ Heap: <code>${formatBytes(memUsage.heapUsed)} / ${formatBytes(memUsage.heapTotal)}</code>\n` +
            `└ RSS: <code>${formatBytes(memUsage.rss)}</code>\n\n` +
            `<code>🕐 ${new Date().toLocaleString()}</code>`
         const keyboard = {
            inline_keyboard: [[
               { text: '🔄 Refresh', callback_data: 'status_refresh' },
               { text: '🛠 Tools',   callback_data: 'start_tools' },
            ]]
         }
         await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: 'HTML', reply_markup: keyboard })
      } catch (error) {
         logger.error('Error in handleStatus:', error)
         await this.bridge.telegramBot.sendMessage(chatId, `❌ <b>Error fetching status</b>\n<code>${this.sanitizeOutput(error.message)}</code>`, { parse_mode: 'HTML' })
      }
   }

   async handleSend(chatId, args) {
      if (args.length < 2) return this.bridge.telegramBot.sendMessage(chatId,
         `📤 <b>Send Message</b>\n\n` +
         `<b>Usage:</b> <code>/send &lt;number&gt; &lt;message&gt;</code>\n` +
         `<b>Example:</b> <code>/send 1234567890 Hello!</code>`,
         { parse_mode: 'HTML' })
      const number = args[0].replace(/\D/g, '')
      const message = args.slice(1).join(' ')
      if (!/^\d{6,15}$/.test(number)) return this.bridge.telegramBot.sendMessage(chatId, '❌ <b>Invalid phone number format.</b>\nMust be 6–15 digits.', { parse_mode: 'HTML' })
      const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`
      try {
         const result = await this.bridge.whatsappClient.sendMessage(jid, { text: message })
         const response = result?.key?.id
            ? `✅ <b>Message sent</b> to <code>+${number}</code>`
            : `✅ <b>Message sent</b> to <code>+${number}</code> <i>(no delivery confirmation)</i>`
         await this.bridge.telegramBot.sendMessage(chatId, response, { parse_mode: 'HTML' })
      } catch (error) {
         await this.bridge.telegramBot.sendMessage(chatId, `❌ <b>Send failed</b>\n<code>${this.sanitizeOutput(error.message)}</code>`, { parse_mode: 'HTML' })
      }
   }

   async handleContacts(chatId, page = 0, messageId = null) {
      const contacts = [...this.bridge.contactMappings.entries()]
      if (contacts.length === 0) {
         const msg = 'ℹ️ <b>No contacts found.</b>'
         if (messageId) await this.bridge.telegramBot.editMessageText(msg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
         else await this.bridge.telegramBot.sendMessage(chatId, msg, { parse_mode: 'HTML' })
         return
      }
      const itemsPerPage = 20
      const totalPages = Math.ceil(contacts.length / itemsPerPage)
      const currentPage = Math.max(0, Math.min(page, totalPages - 1))
      const startIndex = currentPage * itemsPerPage
      const endIndex = Math.min(startIndex + itemsPerPage, contacts.length)
      const contactList = contacts.slice(startIndex, endIndex).map(([phone, name], i) => `${startIndex + i + 1}. ${name || 'Unknown'} (+${phone})`).join('\n')
      const message = `<b>📒 Contacts (${contacts.length})</b>\n<code>━━━━━━━━━━━━━━━━━━━━</code>\nPage ${currentPage + 1} of ${totalPages}\n\n${contactList}`
      const keyboard = []
      const buttonRow = []
      if (currentPage > 0) buttonRow.push({ text: '◀️ Previous', callback_data: `contacts_prev_${currentPage - 1}` })
      if (currentPage < totalPages - 1) buttonRow.push({ text: 'Next ▶️', callback_data: `contacts_next_${currentPage + 1}` })
      if (buttonRow.length) keyboard.push(buttonRow)
      keyboard.push([{ text: '🔙 Back to Tools', callback_data: 'tools_back' }])
      const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      if (messageId) {
         await this.bridge.telegramBot.editMessageText(message, { chat_id: chatId, message_id: messageId, ...opts })
      } else {
         const sent = await this.bridge.telegramBot.sendMessage(chatId, message, opts)
         messageId = sent.message_id
      }
      this.paginationState.set(chatId, { type: 'contacts', currentPage, totalPages, totalItems: contacts.length, messageId })
   }

   async handleSearchContact(chatId, args, page = 0, messageId = null) {
      if (args.length === 0) return this.bridge.telegramBot.sendMessage(chatId, '🔍 <b>Search Contact</b>\n\n<b>Usage:</b> <code>/searchcontact &lt;name or phone&gt;</code>', { parse_mode: 'HTML' })
      const query = args.join(' ').toLowerCase()
      const contacts = [...this.bridge.contactMappings.entries()]
      const matches = contacts.filter(([phone, name]) => phone.includes(query) || name?.toLowerCase().includes(query))
      if (matches.length === 0) {
         const msg = `ℹ️ No contacts found for <b>"${query}"</b>`
         if (messageId) await this.bridge.telegramBot.editMessageText(msg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
         else await this.bridge.telegramBot.sendMessage(chatId, msg, { parse_mode: 'HTML' })
         return
      }
      const itemsPerPage = 15
      const totalPages = Math.ceil(matches.length / itemsPerPage)
      const currentPage = Math.max(0, Math.min(page, totalPages - 1))
      const startIndex = currentPage * itemsPerPage
      const result = matches.slice(startIndex, Math.min(startIndex + itemsPerPage, matches.length)).map(([phone, name], i) => `${startIndex + i + 1}. ${name || 'Unknown'} (+${phone})`).join('\n')
      const message = `<b>🔍 Search: "${query}"</b>\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n📊 <b>${matches.length} matches</b>  —  Page ${currentPage + 1} of ${totalPages}\n\n${result}`
      const keyboard = [], buttonRow = []
      const enc = Buffer.from(query).toString('base64')
      if (currentPage > 0) buttonRow.push({ text: '◀️ Previous', callback_data: `search_prev_${currentPage - 1}_${enc}` })
      if (currentPage < totalPages - 1) buttonRow.push({ text: 'Next ▶️', callback_data: `search_next_${currentPage + 1}_${enc}` })
      if (buttonRow.length) keyboard.push(buttonRow)
      keyboard.push([{ text: '🔙 Back to Tools', callback_data: 'tools_back' }])
      const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      if (messageId) await this.bridge.telegramBot.editMessageText(message, { chat_id: chatId, message_id: messageId, ...opts })
      else { const sent = await this.bridge.telegramBot.sendMessage(chatId, message, opts); messageId = sent.message_id }
      this.paginationState.set(chatId, { type: 'search', query, currentPage, totalPages, totalItems: matches.length, messageId })
   }

   async handleAddFilter(chatId, args) {
      if (args.length === 0) return this.bridge.telegramBot.sendMessage(chatId, '🚫 <b>Add Filter</b>\n\n<b>Usage:</b> <code>/addfilter &lt;word&gt;</code>', { parse_mode: 'HTML' })
      const word = args.join(' ').toLowerCase()
      await this.bridge.addFilter(word)
      await this.bridge.telegramBot.sendMessage(chatId, `✅ <b>Filter added:</b> <code>${word}</code>`, { parse_mode: 'HTML' })
   }

   async handleConfig(chatId, messageId = null) {
      const f = this.bridge.config.telegram.features
      const mode = this.bridge.getForwardMode()
      const modeLabel = { normal: 'Normal', ai: 'As AI', disappearing: 'Disappearing' }
      const onoff = (v) => v ? '🟢 On' : '🔴 Off'
      const text =
         `<b>⚙️ Bridge Config</b>\n` +
         `<code>━━━━━━━━━━━━━━━━━━━━</code>\n\n` +
         `Tap a setting to toggle it. Changes apply immediately and are saved.\n\n` +
         `<i>Forward Mode controls how text sent from Telegram reaches WhatsApp — pick one.</i>`
      const mk = (m) => m === mode ? '✅ ' : ''
      const keyboard = {
         inline_keyboard: [
            [{ text: `📤 Send Outgoing: ${onoff(f.sendOutgoingMessages)}`, callback_data: 'cfg_toggle_sendOutgoingMessages' }],
            [{ text: `🔄 Status Sync: ${onoff(f.statusSync)}`, callback_data: 'cfg_toggle_statusSync' }],
            [{ text: `📞 Call Logs: ${onoff(f.callLogs)}`, callback_data: 'cfg_toggle_callLogs' }],
            [{ text: `🖼 Profile Pic Sync: ${onoff(f.profilePicSync)}`, callback_data: 'cfg_toggle_profilePicSync' }],
            [{ text: `👋 Welcome Message: ${onoff(f.welcomeMessage)}`, callback_data: 'cfg_toggle_welcomeMessage' }],
            [
               { text: `${mk('normal')}💬 Normal`, callback_data: 'cfg_fwdmode_normal' },
               { text: `${mk('ai')}🤖 As AI`, callback_data: 'cfg_fwdmode_ai' },
               { text: `${mk('disappearing')}👻 Disappear`, callback_data: 'cfg_fwdmode_disappearing' },
            ],
            [{ text: '🔙 Back to Tools', callback_data: 'tools_back' }],
         ]
      }
      const opts = { parse_mode: 'HTML', reply_markup: keyboard }
      if (messageId) await this.bridge.telegramBot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts })
      else await this.bridge.telegramBot.sendMessage(chatId, text, opts)
   }

   async handleListFilters(chatId, messageId = null) {
      const backKb = { inline_keyboard: [[{ text: '🔙 Back to Tools', callback_data: 'tools_back' }]] }
      const edit = (txt) => messageId
         ? this.bridge.telegramBot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
         : this.bridge.telegramBot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: backKb })
      if (!this.bridge.filters?.size) return edit('🚫 <b>No filters set.</b>')
      const list = [...this.bridge.filters].map(w => `  • <code>${w}</code>`).join('\n')
      await edit(`<b>🚫 Active Filters (${this.bridge.filters.size})</b>\n<code>━━━━━━━━━━━━━━</code>\n\n${list}`)
   }

   async handleClearFilters(chatId, messageId = null) {
      await this.bridge.clearFilters()
      const backKb = { inline_keyboard: [[{ text: '🔙 Back to Tools', callback_data: 'tools_back' }]] }
      const txt = '✅ <b>All filters cleared.</b>'
      if (messageId) await this.bridge.telegramBot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
      else await this.bridge.telegramBot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: backKb })
   }

   async handlePassword(chatId, args) {
      if (args.length === 0) return this.bridge.telegramBot.sendMessage(chatId, '🔑 <b>Authenticate</b>\n\n<b>Usage:</b> <code>/password &lt;your_password&gt;</code>', { parse_mode: 'HTML' })
      const password = args.join(' ')
      if (this.bridge.authenticateUser(chatId, password)) {
         await this.bridge.telegramBot.sendMessage(chatId, '✅ <b>Authenticated!</b>\n\nYou can now use all commands and reply to bridged messages.', { parse_mode: 'HTML' })
      } else {
         await this.bridge.telegramBot.sendMessage(chatId, '❌ <b>Invalid password.</b> Access denied.', { parse_mode: 'HTML' })
      }
   }

   async handleBackup(chatId, messageId = null) {
      const backKb = { inline_keyboard: [[{ text: '🔙 Back to Tools', callback_data: 'tools_back' }]] }
      try {
         if (messageId) {
            await this.bridge.telegramBot.editMessageText('⏳ <b>Creating backup…</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
         } else {
            const sent = await this.bridge.telegramBot.sendMessage(chatId, '⏳ <b>Creating backup…</b>', { parse_mode: 'HTML' })
            messageId = sent.message_id
         }
         if (this.bridge.database && typeof this.bridge.database.save === 'function') await this.bridge.queueDatabaseSave()
         const backupFileName = `backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
         const backupPath = path.join(process.cwd(), backupFileName)
         
         
         
         
         const dbSnapshot = {
            users: global.db.users || [],
            groups: global.db.groups || [],
            chats: global.db.chats || [],
            instance: global.db.instance || [],
            statistic: global.db.statistic || {},
            sticker: global.db.sticker || {},
            setting: global.db.setting || {},
            bridge: global.db.bridge || { chatMappings: {}, userMappings: {}, contactMappings: {}, filters: [] },
         }
         const backupData = {
            timestamp: new Date().toISOString(),
            version: JSON.parse(fsSync.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version,
            database: dbSnapshot,
            metadata: {
               users: dbSnapshot.users?.length || 0, groups: dbSnapshot.groups?.length || 0,
               chats: dbSnapshot.chats?.length || 0,
               contacts: Object.keys(dbSnapshot.bridge?.contactMappings || {}).length,
               chatMappings: Object.keys(dbSnapshot.bridge?.chatMappings || {}).length,
            },
         }
         await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2), 'utf8')
         const stats = await fs.stat(backupPath)
         await this.bridge.telegramBot.editMessageText(
            `<b>✅ Backup Created</b>\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n\n📅 Date: <code>${new Date().toLocaleString()}</code>\n📦 Size: <code>${this.formatBytes(stats.size)}</code>\n\n<b>Contents</b>\n├ 👤 Users: <code>${backupData.metadata.users}</code>\n├ 👥 Groups: <code>${backupData.metadata.groups}</code>\n├ 💬 Chats: <code>${backupData.metadata.chats}</code>\n├ 📒 Contacts: <code>${backupData.metadata.contacts}</code>\n└ 🗺 Mappings: <code>${backupData.metadata.chatMappings}</code>`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb }
         )
         await this.bridge.telegramBot.sendDocument(chatId, backupPath, { caption: 'Database backup file.' })
         setTimeout(async () => { try { await fs.unlink(backupPath) } catch {} }, 60000)
      } catch (error) {
         logger.error('Error creating backup:', error)
         const errMsg = `❌ <b>Backup Failed</b>\n\n<code>${this.sanitizeOutput(error.message)}</code>`
         if (messageId) await this.bridge.telegramBot.editMessageText(errMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
         else await this.bridge.telegramBot.sendMessage(chatId, errMsg, { parse_mode: 'HTML', reply_markup: backKb })
      }
   }

   async handleRestore(chatId, msg, messageId = null) {
      
      const documentMsg = msg?.document ? msg : msg?.reply_to_message?.document ? msg.reply_to_message : null
      if (!documentMsg) {
         this.waitingForRestore.set(chatId, true)
         
         setTimeout(() => { this.waitingForRestore.delete(chatId) }, 120000)
         const txt = '<b>💾 Database Restore</b>\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n\nSend your backup <code>.json</code> file now.\n\n⚠️ This will <b>replace</b> the current database.\n<i>Request expires in 2 minutes.</i>'
         if (messageId) await this.bridge.telegramBot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
         else await this.bridge.telegramBot.sendMessage(chatId, txt, { parse_mode: 'HTML' })
         return
      }
      await this._performRestore(chatId, documentMsg, messageId)
   }

   async handleRestoreFile(msg) {
      const chatId = msg.chat.id
      this.waitingForRestore.delete(chatId)
      if (!msg.document) {
         await this.bridge.telegramBot.sendMessage(chatId, '❌ <b>No file received.</b> Restore cancelled.', { parse_mode: 'HTML' })
         return
      }
      await this._performRestore(chatId, msg)
   }

   async _performRestore(chatId, documentMsg, messageId = null) {
      const backKb = { inline_keyboard: [[{ text: '🔙 Back to Tools', callback_data: 'tools_back' }]] }
      try {
         if (!documentMsg.document.file_name?.endsWith('.json')) {
            const errTxt = '❌ <b>Invalid file.</b> Please send a <code>.json</code> backup file.'
            if (messageId) await this.bridge.telegramBot.editMessageText(errTxt, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
            else await this.bridge.telegramBot.sendMessage(chatId, errTxt, { parse_mode: 'HTML' })
            return
         }
         if (messageId) {
            await this.bridge.telegramBot.editMessageText('⏳ <b>Restoring database…</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
         } else {
            const sent = await this.bridge.telegramBot.sendMessage(chatId, '⏳ <b>Restoring database…</b>', { parse_mode: 'HTML' })
            messageId = sent.message_id
         }
         const fileInfo = await this.bridge.telegramBot.getFile(documentMsg.document.file_id)
         const fileUrl = `https://api.telegram.org/file/bot${this.bridge.config.telegram.botToken}/${fileInfo.file_path}`
         const response = await axios.get(fileUrl, { responseType: 'text' })
         let backupData
         try { backupData = JSON.parse(response.data) } catch { throw new Error('Invalid JSON format in backup file') }
         if (!backupData.database) throw new Error('Invalid backup file: missing database section')
         const preRestorePath = path.join(process.cwd(), `pre_restore_backup_${Date.now()}.json`)
         
         
         const preRestoreSnapshot = {
            users: global.db.users || [], groups: global.db.groups || [], chats: global.db.chats || [],
            instance: global.db.instance || [], statistic: global.db.statistic || {}, sticker: global.db.sticker || {},
            setting: global.db.setting || {}, bridge: global.db.bridge || {},
         }
         await fs.writeFile(preRestorePath, JSON.stringify(preRestoreSnapshot, null, 2), 'utf8')
         
         
         
         
         
         
         
         
         
         const restoredDb = backupData.database

         const replaceArray = (liveArr, newArr) => {
            if (!Array.isArray(liveArr) || !Array.isArray(newArr)) return false
            liveArr.length = 0
            liveArr.push(...newArr)
            return true
         }
         const replaceObject = (liveObj, newObj) => {
            if (typeof liveObj !== 'object' || liveObj === null || typeof newObj !== 'object' || newObj === null) return false
            for (const k of Object.keys(liveObj)) delete liveObj[k]
            Object.assign(liveObj, newObj)
            return true
         }

         if (!global.db.bridge) global.db.bridge = { chatMappings: {}, userMappings: {}, contactMappings: {}, filters: [] }

         if (restoredDb.users !== undefined && !replaceArray(global.db.users, restoredDb.users)) global.db.users = restoredDb.users
         if (restoredDb.groups !== undefined && !replaceArray(global.db.groups, restoredDb.groups)) global.db.groups = restoredDb.groups
         if (restoredDb.chats !== undefined && !replaceArray(global.db.chats, restoredDb.chats)) global.db.chats = restoredDb.chats
         if (restoredDb.instance !== undefined && !replaceArray(global.db.instance, restoredDb.instance)) global.db.instance = restoredDb.instance
         if (restoredDb.statistic !== undefined && !replaceObject(global.db.statistic, restoredDb.statistic)) global.db.statistic = restoredDb.statistic
         if (restoredDb.sticker !== undefined && !replaceObject(global.db.sticker, restoredDb.sticker)) global.db.sticker = restoredDb.sticker
         if (restoredDb.setting !== undefined && !replaceObject(global.db.setting, restoredDb.setting)) global.db.setting = restoredDb.setting
         if (restoredDb.bridge !== undefined && !replaceObject(global.db.bridge, restoredDb.bridge)) global.db.bridge = restoredDb.bridge

         if (this.bridge.database && typeof this.bridge.database.save === 'function') await this.bridge.queueDatabaseSave()
         await this.bridge.loadMappingsFromDb()
         
         const verifiedUsers = global.db.users?.length || 0
         const verifiedGroups = global.db.groups?.length || 0
         const verifiedChats = global.db.chats?.length || 0
         const expectedUsers = restoredDb.users?.length || 0
         const expectedGroups = restoredDb.groups?.length || 0
         const expectedChats = restoredDb.chats?.length || 0
         const mismatch = verifiedUsers !== expectedUsers || verifiedGroups !== expectedGroups || verifiedChats !== expectedChats
         if (mismatch) logger.error(`Restore verification mismatch: expected users/groups/chats ${expectedUsers}/${expectedGroups}/${expectedChats}, got ${verifiedUsers}/${verifiedGroups}/${verifiedChats}`)
         const warningLine = mismatch
            ? `\n\n⚠️ <b>Warning:</b> expected <code>${expectedUsers}</code> users/<code>${expectedGroups}</code> groups/<code>${expectedChats}</code> chats from the backup, but only <code>${verifiedUsers}</code>/<code>${verifiedGroups}</code>/<code>${verifiedChats}</code> landed. The write-back may not have persisted — check logs.`
            : ''
         await this.bridge.telegramBot.editMessageText(
            `<b>✅ Database Restored</b>\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n\n📅 Backup: <code>${backupData.timestamp ? new Date(backupData.timestamp).toLocaleString() : 'Unknown'}</code>\n\n<b>Restored data</b>\n├ 👤 Users: <code>${verifiedUsers}</code>\n├ 👥 Groups: <code>${verifiedGroups}</code>\n└ 💬 Chats: <code>${verifiedChats}</code>\n\n<i>⚠️ Restart the bot for full effect.</i>${warningLine}`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb }
         )
         setTimeout(async () => { try { await fs.unlink(preRestorePath) } catch {} }, 300000)
      } catch (error) {
         logger.error('Error restoring database:', error)
         const errMsg = `❌ <b>Restore Failed</b>\n\n<code>${this.sanitizeOutput(error.message)}</code>`
         if (messageId) await this.bridge.telegramBot.editMessageText(errMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
         else await this.bridge.telegramBot.sendMessage(chatId, errMsg, { parse_mode: 'HTML', reply_markup: backKb })
      }
   }

   async handleUpdateTopics(chatId, messageId = null) {
      const backKb = { inline_keyboard: [[{ text: '🔙 Back to Tools', callback_data: 'tools_back' }]] }
      try {
         if (messageId) {
            await this.bridge.telegramBot.editMessageText('⏳ <b>Updating topic names…</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
         } else {
            const sent = await this.bridge.telegramBot.sendMessage(chatId, '⏳ <b>Updating topic names…</b>', { parse_mode: 'HTML' })
            messageId = sent.message_id
         }
         await this.bridge.syncContacts()
         let updatedCount = 0, errorCount = 0
         for (const [jid, topicId] of this.bridge.chatMappings.entries()) {
            try {
               let newName
               if (jid === 'status@broadcast') newName = '📊 Status Updates'
               else if (jid === 'call@broadcast') newName = '📞 Call Logs'
               else if (jid.endsWith('@g.us')) {
                  try { const meta = await this.bridge.whatsappClient.groupMetadata(jid); newName = meta.subject } catch { newName = 'Group Chat' }
               } else {
                  const phone = jid.split('@')[0]
                  const name = this.bridge.contactMappings.get(phone)
                  newName = name && name !== phone && !name.startsWith('+') ? name : `+${phone}`
               }
               await this.bridge.telegramBot.editForumTopic(this.bridge.config.telegram.chatId, topicId, { name: newName })
               updatedCount++
               await new Promise(r => setTimeout(r, 200))
            } catch { errorCount++ }
         }
         await this.bridge.telegramBot.editMessageText(
            `<b>✅ Topics Updated</b>\n\n✔️ Updated: <code>${updatedCount}</code>\n❌ Errors: <code>${errorCount}</code>`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb }
         )
      } catch (error) {
         const errMsg = `❌ <b>Update Failed</b>\n\n<code>${this.sanitizeOutput(error.message)}</code>`
         if (messageId) await this.bridge.telegramBot.editMessageText(errMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
         else await this.bridge.telegramBot.sendMessage(chatId, errMsg, { parse_mode: 'HTML', reply_markup: backKb })
      }
   }

   async handleRestart(chatId, messageId = null) {
      const backKb = { inline_keyboard: [[{ text: '🔙 Back to Tools', callback_data: 'tools_back' }]] }
      try {
         if (messageId) {
            await this.bridge.telegramBot.editMessageText('🔄 <b>Restarting bot…</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
         } else {
            const sent = await this.bridge.telegramBot.sendMessage(chatId, '🔄 <b>Restarting bot…</b>', { parse_mode: 'HTML' })
            messageId = sent.message_id
         }
         if (this.bridge.database && typeof this.bridge.database.save === 'function') await this.bridge.queueDatabaseSave()
         await this.bridge.telegramBot.editMessageText('🔄 <b>Bot is restarting.</b> Please wait a moment…', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
         process.send('reset')
      } catch (error) {
         const errMsg = `❌ <b>Restart Failed</b>\n\n<code>${this.sanitizeOutput(error.message)}</code>`
         if (messageId) await this.bridge.telegramBot.editMessageText(errMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
         else await this.bridge.telegramBot.sendMessage(chatId, errMsg, { parse_mode: 'HTML', reply_markup: backKb })
      }
   }

   async handleUpdateBot(chatId, messageId = null) {
      const backKb = { inline_keyboard: [[{ text: '🔙 Back to Tools', callback_data: 'tools_back' }]] }
      try {
         if (messageId) {
            await this.bridge.telegramBot.editMessageText('⏳ <b>Checking for updates…</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
         } else {
            const sent = await this.bridge.telegramBot.sendMessage(chatId, '⏳ <b>Checking for updates…</b>', { parse_mode: 'HTML' })
            messageId = sent.message_id
         }
         const gitDir = path.join(process.cwd(), '.git')
         if (!fsSync.existsSync(gitDir)) {
            await this.bridge.telegramBot.editMessageText('❌ <b>Update Failed</b>\n\nNot a Git repository.', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
            return
         }
         exec('git pull', { cwd: process.cwd() }, async (error, stdout, stderr) => {
            if (error) {
               await this.bridge.telegramBot.editMessageText(`❌ <b>Update Failed</b>\n\n<code>${this.sanitizeOutput(error.message)}</code>\n\n<pre>${this.sanitizeOutput(stderr).substring(0, 500)}</pre>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
               return
            }
            if (stdout.includes('Already up to date.')) {
               await this.bridge.telegramBot.editMessageText('✅ <b>Already up to date!</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
            } else {
               await this.bridge.telegramBot.editMessageText(`<b>✅ Bot Updated!</b>\n\n<pre>${this.sanitizeOutput(stdout).substring(0, 500)}</pre>\n<i>Use /restart to apply changes.</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
            }
         })
      } catch (error) {
         const errMsg = `❌ <b>Update Failed</b>\n\n<code>${this.sanitizeOutput(error.message)}</code>`
         if (messageId) await this.bridge.telegramBot.editMessageText(errMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb })
         else await this.bridge.telegramBot.sendMessage(chatId, errMsg, { parse_mode: 'HTML', reply_markup: backKb })
      }
   }

   async handleJoinGroup(chatId, args) {
      let messageId
      try {
         if (args.length === 0) return this.bridge.telegramBot.sendMessage(chatId, '👥 <b>Join Group</b>\n\n<b>Usage:</b> <code>/joingroup &lt;WhatsApp_invite_link&gt;</code>', { parse_mode: 'HTML' })
         const sent = await this.bridge.telegramBot.sendMessage(chatId, '⏳ <b>Joining group…</b>', { parse_mode: 'HTML' })
         messageId = sent.message_id
         const link = args[0]
         const match = link.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/i)
         if (!match?.[1]) throw new Error('Invalid WhatsApp group invite link.')
         const groupId = await this.bridge.whatsappClient.groupAcceptInvite(match[1])
         if (!groupId?.endsWith('g.us')) throw new Error('Failed to join. Link may be invalid or expired.')
         const meta = await this.bridge.whatsappClient.groupMetadata(groupId)
         await this.bridge.telegramBot.editMessageText(`✅ <b>Joined group!</b>\n👥 ${meta?.subject || 'Unknown Group'}`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' })
      } catch (error) {
         const errMsg = `❌ <b>Failed to Join Group</b>\n\n<code>${this.sanitizeOutput(error.message)}</code>`
         if (messageId) await this.bridge.telegramBot.editMessageText(errMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' })
         else await this.bridge.telegramBot.sendMessage(chatId, errMsg, { parse_mode: 'HTML' })
      }
   }

   async handleListGroups(chatId, page = 0, messageId = null) {
      try {
         const sentMessage = messageId ? null : await this.bridge.telegramBot.sendMessage(chatId, '⏳ <b>Fetching groups…</b>', { parse_mode: 'HTML' })
         messageId = messageId || sentMessage.message_id
         const groups = Object.values(await this.bridge.whatsappClient.groupFetchAllParticipating())
         if (groups.length === 0) {
            await this.bridge.telegramBot.editMessageText('ℹ️ <b>No groups found.</b>', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
            return
         }
         const itemsPerPage = 10
         const totalPages = Math.ceil(groups.length / itemsPerPage)
         const currentPage = Math.max(0, Math.min(page, totalPages - 1))
         const startIndex = currentPage * itemsPerPage
         const groupList = groups.slice(startIndex, Math.min(startIndex + itemsPerPage, groups.length))
            .map((g, i) => `${startIndex + i + 1}. <b>${g.subject || 'Unknown'}</b>  <i>${g.participants?.length || 0} members</i>\n<code>${g.id}</code>`).join('\n\n')
         const message = `<b>👥 Joined Groups (${groups.length})</b>\n<code>━━━━━━━━━━━━━━━━━━━━</code>\nPage ${currentPage + 1} of ${totalPages}\n\n${groupList}`
         const keyboard = [], buttonRow = []
         if (currentPage > 0) buttonRow.push({ text: '◀️ Previous', callback_data: `listgroups_prev_${currentPage - 1}` })
         if (currentPage < totalPages - 1) buttonRow.push({ text: 'Next ▶️', callback_data: `listgroups_next_${currentPage + 1}` })
         if (buttonRow.length) keyboard.push(buttonRow)
         keyboard.push([{ text: '🔙 Back to Tools', callback_data: 'tools_back' }])
         await this.bridge.telegramBot.editMessageText(message, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } })
         this.paginationState.set(chatId, { type: 'listgroups', currentPage, totalPages, totalItems: groups.length, messageId })
      } catch (error) {
         const errMsg = `❌ <b>Failed to List Groups</b>\n\n<code>${this.sanitizeOutput(error.message)}</code>`
         if (messageId) await this.bridge.telegramBot.editMessageText(errMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' })
         else await this.bridge.telegramBot.sendMessage(chatId, errMsg, { parse_mode: 'HTML' })
      }
   }

   async handleCallbackQuery(callbackQuery) {
      const chatId = callbackQuery.message.chat.id
      const messageId = callbackQuery.message.message_id
      const data = callbackQuery.data
      const userId = callbackQuery.from.id
      if (!this.bridge.isUserAuthenticated(userId)) {
         await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, { text: 'Access denied. Use /password to authenticate.', show_alert: true })
         return
      }
      try {
         if (data.startsWith('contacts_')) {
            const parts = data.split('_'); const page = parseInt(parts[2])
            await this.handleContacts(chatId, page, messageId)
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, { text: `📄 Page ${page + 1}` })
         } else if (data.startsWith('search_')) {
            const parts = data.split('_'); const page = parseInt(parts[2]); const query = Buffer.from(parts[3], 'base64').toString()
            await this.handleSearchContact(chatId, [query], page, messageId)
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, { text: `📄 Page ${page + 1}` })
         } else if (data.startsWith('listgroups_')) {
            const parts = data.split('_'); const page = parseInt(parts[2])
            await this.handleListGroups(chatId, page, messageId)
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, { text: `📄 Page ${page + 1}` })
         } else if (data === 'tools_back') {
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id)
            await this.handleTools(chatId, messageId)
         } else if (data.startsWith('cfg_fwdmode_')) {
            const mode = data.slice(12) 
            await this.bridge.setForwardMode(mode)
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, { text: `✅ Forward mode: ${mode}` })
            await this.handleConfig(chatId, messageId)
         } else if (data.startsWith('cfg_toggle_')) {
            const key = data.slice(11) 
            await this.bridge.toggleFeature(key)
            const newVal = this.bridge.config.telegram.features[key]
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, { text: newVal ? '🟢 Enabled' : '🔴 Disabled' })
            await this.handleConfig(chatId, messageId)
         } else if (data.startsWith('tools_')) {
            const action = data.slice(6) 
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id)
            switch (action) {
               case 'contacts':     await this.handleContacts(chatId, 0, messageId); break
               case 'listgroups':   await this.handleListGroups(chatId, 0, messageId); break
               case 'updatetopics': await this.handleUpdateTopics(chatId, messageId); break
               case 'filters':      await this.handleListFilters(chatId, messageId); break
               case 'clearfilters': await this.handleClearFilters(chatId, messageId); break
               case 'config':       await this.handleConfig(chatId, messageId); break
               case 'backup':       await this.handleBackup(chatId, messageId); break
               case 'restore':      await this.handleRestore(chatId, callbackQuery.message, messageId); break
               case 'restart':      await this.handleRestart(chatId, messageId); break
               case 'updatebot':    await this.handleUpdateBot(chatId, messageId); break
            }
         } else if (data.startsWith('start_')) {
            const action = data.slice(6)
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id)
            switch (action) {
               case 'tools':  await this.handleTools(chatId); break
               case 'status': await this.handleStatus(chatId); break
               case 'help':   await this.handleMenu(chatId); break
            }
         } else if (data === 'status_refresh') {
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, { text: '🔄 Refreshed!' })
            await this.handleStatus(chatId)
         }
      } catch (error) {
         logger.error('Error handling callback query:', error)
         await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, { text: 'An error occurred.', show_alert: true })
      }
   }

   async handleMenu(chatId) {
      const message =
         `<b>📋 Command Reference</b>\n` +
         `<code>━━━━━━━━━━━━━━━━━━━━</code>\n\n` +
         `<b>✍️ Commands with input</b>\n` +
         `├ /send <code>&lt;number&gt; &lt;msg&gt;</code>\n` +
         `│  <i>Send a WhatsApp message</i>\n` +
         `├ /searchcontact <code>&lt;name or number&gt;</code>\n` +
         `│  <i>Search your contacts</i>\n` +
         `├ /addfilter <code>&lt;word&gt;</code>\n` +
         `│  <i>Block messages starting with a word</i>\n` +
         `├ /joingroup <code>&lt;invite link&gt;</code>\n` +
         `│  <i>Join a WhatsApp group</i>\n` +
         `└ /password <code>&lt;pass&gt;</code>\n` +
         `   <i>Authenticate to use the bridge</i>\n\n` +
         `<b>⚡ Quick access</b>\n` +
         `├ /tools — 🛠 System panel &amp; action buttons\n` +
         `├ /status — 📊 Connection &amp; memory info\n` +
         `└ /start — 🌉 Bridge uptime &amp; info`
      const keyboard = {
         inline_keyboard: [
            [
               { text: '🛠 Tools',   callback_data: 'start_tools' },
               { text: '📊 Status', callback_data: 'start_status' },
            ]
         ]
      }
      await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup: keyboard })
   }

   async handleTools(chatId, messageId = null) {
      const os = (await import('os')).default
      const { execSync } = (await import('child_process'))

      const fmtBytes = (b) => {
         if (!b) return '0 B'
         const units = ['B', 'KB', 'MB', 'GB', 'TB']
         const i = Math.floor(Math.log(b) / Math.log(1024))
         return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
      }
      const fmtUptime = (s) => {
         const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
         const m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
         if (d > 0) return `${d}d ${h}h ${m}m ${sec}s`
         if (h > 0) return `${h}h ${m}m ${sec}s`
         if (m > 0) return `${m}m ${sec}s`
         return `${sec}s`
      }
      const fmtPct = (v) => `${(v * 100).toFixed(1)}%`

      
      const cpus = os.cpus()
      const cpuModel = cpus[0]?.model?.trim().replace(/\s+/g, ' ') || 'Unknown'
      const cpuCores = cpus.length
      const load = os.loadavg()
      const cpuPct = fmtPct(Math.min(load[0] / cpuCores, 1))

      
      const totalMem  = os.totalmem()
      const freeMem   = os.freemem()
      const usedMem   = totalMem - freeMem
      const memPct    = fmtPct(usedMem / totalMem)

      
      const mem = process.memoryUsage()

      
      let diskInfo = '—'
      try {
         const df = execSync("df -B1 / | tail -1").toString().trim().split(/\s+/)
         const dTotal = parseInt(df[1]), dUsed = parseInt(df[2])
         diskInfo = `${fmtBytes(dUsed)} / ${fmtBytes(dTotal)} (${fmtPct(dUsed / dTotal)})`
      } catch {}

      
      let osRelease = `${os.type()} ${os.release()}`
      try {
         const raw = fsSync.readFileSync('/etc/os-release', 'utf8')
         const match = raw.match(/PRETTY_NAME="?([^"\n]+)"?/)
         const pretty = match ? match[1].trim() : ''
         if (pretty) osRelease = pretty
      } catch {}

      const nodeUptime = fmtUptime(process.uptime())
      const sysUptime  = fmtUptime(os.uptime())
      const now        = new Date()
      const ts         = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`

      
      const bar = (pct, len = 10) => {
         const filled = Math.round(Math.min(pct, 100) / 100 * len)
         return '█'.repeat(filled) + '░'.repeat(len - filled)
      }
      const ramPctNum  = usedMem / totalMem * 100
      const cpuPctNum  = Math.min(load[0] / cpuCores, 1) * 100

      const text =
         `<b>🛠 Tools &amp; System Monitor</b>\n` +
         `<code>━━━━━━━━━━━━━━━━━━━━</code>\n\n` +
         `<blockquote expandable>` +
         `<b>🖥 Server</b>\n` +
         `├ 🐧 OS: <code>${osRelease}</code>\n` +
         `├ 🏷 Host: <code>${os.hostname()}</code>\n` +
         `├ ⚡ CPU: <code>${cpuModel}</code>\n` +
         `├ 🔢 Cores: <code>${cpuCores}</code>  Arch: <code>${os.arch()}</code>\n` +
         `├ 📊 Load: <code>[${bar(cpuPctNum)}] ${cpuPct}</code>\n` +
         `│  <i>(1m/5m/15m: ${load[0].toFixed(2)} / ${load[1].toFixed(2)} / ${load[2].toFixed(2)})</i>\n` +
         `└ ⏱ Uptime: <code>${sysUptime}</code>\n\n` +
         `<b>💾 Memory &amp; Disk</b>\n` +
         `├ 🧠 RAM: <code>[${bar(ramPctNum)}] ${memPct}</code>\n` +
         `│  <code>${fmtBytes(usedMem)} used / ${fmtBytes(totalMem)} total</code>\n` +
         `└ 💿 Disk: <code>${diskInfo}</code>\n\n` +
         `<b>⚙️ Process</b>\n` +
         `├ 🟩 Node.js: <code>${process.version}</code>\n` +
         `├ 🧱 Heap: <code>${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}</code>\n` +
         `├ 📦 RSS: <code>${fmtBytes(mem.rss)}</code>\n` +
         `└ ⏱ Uptime: <code>${nodeUptime}</code>` +
         `</blockquote>`

      const keyboard = {
         inline_keyboard: [
            [
               { text: '📒 Contacts',      callback_data: 'tools_contacts' },
               { text: '👥 List Groups',   callback_data: 'tools_listgroups' },
            ],
            [
               { text: '🚫 Filters',       callback_data: 'tools_filters' },
               { text: '🗑 Clear Filters', callback_data: 'tools_clearfilters' },
            ],
            [
               { text: '💾 Backup',        callback_data: 'tools_backup' },
               { text: '📥 Restore',       callback_data: 'tools_restore' },
            ],
            [
               { text: '🏷 Update Topics', callback_data: 'tools_updatetopics' },
               { text: '⬆️ Update Bot',    callback_data: 'tools_updatebot' },
            ],
            [
               { text: '⚙️ Config',        callback_data: 'tools_config' },
               { text: '🔄 Restart',       callback_data: 'tools_restart' },
            ],
         ]
      }
      if (messageId) {
         await this.bridge.telegramBot.editMessageText(text, {
            chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard
         })
      } else {
         await this.bridge.telegramBot.sendMessage(chatId, text, {
            parse_mode: 'HTML', reply_markup: keyboard
         })
      }
   }

   async registerBotCommands() {
      try {
         await this.bridge.telegramBot.setMyCommands([
            { command: 'start',         description: 'Show bot info' },
            { command: 'tools',         description: 'Open tools menu with buttons' },
            { command: 'send',          description: 'Send <number> <msg> - Send a WhatsApp message' },
            { command: 'searchcontact', description: 'Search WhatsApp contacts by name or number' },
            { command: 'addfilter',     description: 'Add <word> - Block messages starting with word' },
            { command: 'joingroup',     description: 'Join <link> - Join a WhatsApp group' },
            { command: 'password',      description: 'Authenticate with password' },
         ])
      } catch (error) {
         logger.error('Failed to register Telegram bot commands:', error)
      }
   }
}

export default class TelegramBridge {
   constructor(whatsappClient, database) {
      this.whatsappClient = whatsappClient
      this.database = database
      this.telegramBot = null
      this.commands = null
      this.chatMappings = new Map()
      this.userMappings = new Map()
      this.contactMappings = new Map()
      this.profilePicCache = new Map()
      this.tempDir = path.join(__dirname, '../temp')
      this.isProcessing = false
      this.activeCallNotifications = new Map()
      this.statusMessageMapping = new Map()
      this.botChatId = null
      this.topicVerificationCache = new Map()
      this.creatingTopics = new Map()
      
      this._perJidQueue = new Map()   
      this.filters = new Set()
      this.authenticatedUsers = new Map()
      this.authTimeout = 24 * 60 * 60 * 1000
      
      
      
      
      const tg = Config.telegram || {}
      this.password = tg.password || 'admin123'
      this.sudoUsers = new Set((tg.sudo_users || []).map(id => String(id).trim()).filter(Boolean))
      this.config = {
         telegram: {
            botToken:  tg.bot_token   || '',
            chatId:    String(tg.chat_id    || ''),
            enabled:   tg.enabled !== false,
            features: {
               sendOutgoingMessages:          true,
               statusSync:                    true,
               callLogs:                      true,
               profilePicSync:                true,
               welcomeMessage:                true,
               telegramForwardAsAI:           false,
               telegramForwardAsDisappearing: false,
            },
         },
      }
      this.messageMapping = new Map()
   }

   

   async initialize() {
      const token = this.config.telegram.botToken
      const chatId = this.config.telegram.chatId
      if (!token || !chatId) {
         logger.warn('Telegram bot_token or chat_id not set in config.json')
         return
      }
      try {
         await fs.mkdir(this.tempDir, { recursive: true })
         this.telegramBot = new TelegramBot(token, { polling: true, onlyFirstMatch: true })
         this.commands = new TelegramCommands(this)
         await this.commands.registerBotCommands()
         await this.setupTelegramHandlers()
         await this.loadMappingsFromDb()
         await this.loadFiltersFromDb()
         this.loadFeatureSettingsFromDb()
         logger.info('Telegram bridge initialized')
      } catch (error) {
         logger.error('Failed to initialize Telegram bridge:', error)
      }
   }

   

   async loadMappingsFromDb() {
      try {
         if (!global.db.bridge || typeof global.db.bridge !== 'object') {
            global.db.bridge = { chatMappings: {}, userMappings: {}, contactMappings: {}, filters: [] }
            }
         const bridgeData = global.db.bridge || { chatMappings: {}, userMappings: {}, contactMappings: {}, filters: [] }

         this.chatMappings = new Map()
         this.userMappings = new Map()
         this.contactMappings = new Map()
         this.filters = new Set()

         if (bridgeData.chatMappings && typeof bridgeData.chatMappings === 'object') {
            for (const [jid, chatMapData] of Object.entries(bridgeData.chatMappings)) {
               const topicId = typeof chatMapData === 'object' && chatMapData !== null ? chatMapData.telegramTopicId : chatMapData
               if (jid && typeof topicId === 'number') {
                  this.chatMappings.set(jid, topicId)
                  if (typeof chatMapData === 'object' && chatMapData.profilePicUrl) this.profilePicCache.set(jid, chatMapData.profilePicUrl)
               }
            }
         }
         if (bridgeData.userMappings && typeof bridgeData.userMappings === 'object') {
            for (const [jid, userData] of Object.entries(bridgeData.userMappings)) {
               if (jid && userData) this.userMappings.set(jid, userData)
            }
         }
         if (bridgeData.contactMappings && typeof bridgeData.contactMappings === 'object') {
            for (const [phone, name] of Object.entries(bridgeData.contactMappings)) {
               if (phone && name) this.contactMappings.set(phone, name)
            }
         }
         if (Array.isArray(bridgeData.filters)) {
            bridgeData.filters.forEach(f => { if (f && typeof f === 'string') this.filters.add(f) })
         }

      } catch (error) {
         logger.error('Failed to load mappings from database:', error)
         this.chatMappings = new Map()
         this.userMappings = new Map()
         this.contactMappings = new Map()
         this.filters = new Set()
      }
   }

   
   
   
   
   
   queueDatabaseSave() {
      this._saveChain = (this._saveChain || Promise.resolve()).then(async () => {
         if (this.database && typeof this.database.save === 'function') await this.database.save(global.db)
      })
      return this._saveChain
   }

   saveMappingsToDb() {
      this._saveChain = (this._saveChain || Promise.resolve()).then(() => this._doSaveMappingsToDb())
      return this._saveChain
   }

   async _doSaveMappingsToDb() {
      try {
         if (!global.db.bridge || typeof global.db.bridge !== 'object') {
            global.db.bridge = { chatMappings: {}, userMappings: {}, contactMappings: {}, filters: [] }
         }
         const chatMappingsObj = {}, userMappingsObj = {}, contactMappingsObj = {}
         for (const [jid, topicId] of this.chatMappings.entries()) {
            if (jid && topicId && typeof topicId === 'number') {
               chatMappingsObj[jid] = { telegramTopicId: topicId, profilePicUrl: this.profilePicCache.get(jid) || null, lastActivity: new Date() }
            }
         }
         for (const [jid, userData] of this.userMappings.entries()) { if (jid && userData) userMappingsObj[jid] = userData }
         for (const [phone, name] of this.contactMappings.entries()) { if (phone && name) contactMappingsObj[phone] = name }
         global.db.bridge.chatMappings = chatMappingsObj
         global.db.bridge.userMappings = userMappingsObj
         global.db.bridge.contactMappings = contactMappingsObj
         global.db.bridge.filters = Array.from(this.filters).filter(f => f && typeof f === 'string')
         if (this.database && typeof this.database.save === 'function') await this.database.save(global.db)

      } catch (error) {
         logger.error('Failed to save mappings to database:', error)
      }
   }

   async loadFiltersFromDb() {
      try {
         const bridgeData = global.db.bridge || {}
         this.filters = new Set()
         if (Array.isArray(bridgeData.filters)) {
            bridgeData.filters.forEach(f => { if (f && typeof f === 'string') this.filters.add(f) })
         }
      } catch (error) {
         logger.error('Failed to load filters:', error)
         this.filters = new Set()
      }
   }

   async addFilter(word) { this.filters.add(word); await this.saveMappingsToDb() }
   async clearFilters() { this.filters.clear(); await this.saveMappingsToDb() }

   
   
   
   

   loadFeatureSettingsFromDb() {
      try {
         const saved = global.db.bridge && typeof global.db.bridge === 'object' ? global.db.bridge.settings : null
         if (saved && typeof saved === 'object') {
            for (const key of Object.keys(this.config.telegram.features)) {
               if (typeof saved[key] === 'boolean') this.config.telegram.features[key] = saved[key]
            }
         }
      } catch (error) {
         logger.error('Failed to load feature settings from database:', error)
      }
   }

   async persistFeatureSettings() {
      try {
         if (!global.db.bridge || typeof global.db.bridge !== 'object') {
            global.db.bridge = { chatMappings: {}, userMappings: {}, contactMappings: {}, filters: [] }
         }
         global.db.bridge.settings = { ...this.config.telegram.features }
         if (this.database && typeof this.database.save === 'function') await this.queueDatabaseSave()
      } catch (error) {
         logger.error('Failed to save feature settings to database:', error)
      }
   }

   
   async toggleFeature(key) {
      if (!(key in this.config.telegram.features)) return
      this.config.telegram.features[key] = !this.config.telegram.features[key]
      await this.persistFeatureSettings()
   }

   
   getForwardMode() {
      if (this.config.telegram.features.telegramForwardAsAI) return 'ai'
      if (this.config.telegram.features.telegramForwardAsDisappearing) return 'disappearing'
      return 'normal'
   }

   async setForwardMode(mode) {
      if (!['normal', 'ai', 'disappearing'].includes(mode)) return
      this.config.telegram.features.telegramForwardAsAI = mode === 'ai'
      this.config.telegram.features.telegramForwardAsDisappearing = mode === 'disappearing'
      await this.persistFeatureSettings()
   }

   

   isUserAuthenticated(userId) {
      if (this.sudoUsers.has(userId.toString())) return true
      const authData = this.authenticatedUsers.get(userId)
      if (!authData) return false
      if (Date.now() - authData.timestamp > this.authTimeout) { this.authenticatedUsers.delete(userId); return false }
      return authData.authenticated
   }

   authenticateUser(userId, password) {
      if (password === this.password) {
         this.authenticatedUsers.set(userId, { authenticated: true, timestamp: Date.now() })
         return true
      }
      return false
   }

   

   async setupTelegramHandlers() {
      this.telegramBot.on('message', this.wrapHandler(async (msg) => {
         
         const isServiceMessage = !!(msg.pinned_message || msg.forum_topic_created || msg.forum_topic_edited || msg.forum_topic_closed || msg.forum_topic_reopened || msg.new_chat_members || msg.left_chat_member)
         if (msg.chat.type === 'private') {
            this.botChatId = msg.chat.id
            
            if (this.commands.waitingForRestore.has(msg.chat.id) && msg.document) {
               await this.commands.handleRestoreFile(msg)
               return
            }
            await this.commands.handleCommand(msg)
         } else if (msg.chat.type === 'supergroup' && msg.is_topic_message && !isServiceMessage) {
            await this.handleTelegramMessage(msg)
         }
      }))
      this.telegramBot.on('callback_query', this.wrapHandler(async (callbackQuery) => {
         await this.commands.handleCallbackQuery(callbackQuery)
      }))
      this.telegramBot.on('polling_error', (error) => logger.error('Telegram polling error:', error))
      this.telegramBot.on('error', (error) => logger.error('Telegram bot error:', error))
   }

   wrapHandler(handler) {
      return async (...args) => {
         try { await handler(...args) } catch (error) { logger.error('Unhandled error in Telegram handler:', error) }
      }
   }

   

   

   
   
   
   
   async syncMessage(whatsappMsg, text, participants = []) {
      if (!this.telegramBot || !this.config.telegram.enabled) return
      const jid = whatsappMsg.key.remoteJid || 'unknown'
      const prev = this._perJidQueue.get(jid) || Promise.resolve()
      const next = prev.then(() => this._syncMessageImpl(whatsappMsg, text, participants)).catch(err => {
         logger.error(`[perJidQueue] error for ${jid}:`, err?.message || err)
      })
      this._perJidQueue.set(jid, next)
      
      next.then(() => { if (this._perJidQueue.get(jid) === next) this._perJidQueue.delete(jid) })
      return next
   }

   async _syncMessageImpl(whatsappMsg, text, participants = []) {

      const rawChatJid = whatsappMsg.key.remoteJid
      let sender = resolveLid(this.whatsappClient, rawChatJid, participants, whatsappMsg.key.remoteJidAlt)

      // If a topic already exists under the raw (unresolved) lid from before this fix,
      // move it over to the resolved phone jid instead of creating a duplicate topic.
      if (sender !== rawChatJid && this.chatMappings.has(rawChatJid) && !this.chatMappings.has(sender)) {
         const migratedTopicId = this.chatMappings.get(rawChatJid)
         this.chatMappings.set(sender, migratedTopicId)
         this.chatMappings.delete(rawChatJid)
         if (this.profilePicCache.has(rawChatJid)) {
            this.profilePicCache.set(sender, this.profilePicCache.get(rawChatJid))
            this.profilePicCache.delete(rawChatJid)
         }
         await this.saveMappingsToDb()
         logger.info(`Migrated chat mapping ${rawChatJid} -> ${sender} (topic ${migratedTopicId})`)
      }

      const rawParticipant = whatsappMsg.key.participant || ''
      let participant = rawParticipant
         ? resolveLid(this.whatsappClient, rawParticipant, participants, whatsappMsg.key.participantAlt)
         : (sender !== 'status@broadcast' ? sender : '')
      const isFromMe = whatsappMsg.key.fromMe

      if (sender === 'status@broadcast') {
         await this.handleStatusMessage(whatsappMsg, text, participants, participant || null)
         return
      }

      const messageContent = whatsappMsg.message || {}
      const typeLabel = messageContent.stickerMessage ? 'sticker'
         : (messageContent.ptvMessage || messageContent.videoMessage?.ptv) ? 'video_note'
         : messageContent.imageMessage ? 'image'
         : messageContent.videoMessage ? 'video'
         : messageContent.audioMessage ? 'audio'
         : messageContent.documentMessage ? 'document'
         : messageContent.locationMessage ? 'location'
         : messageContent.contactMessage ? 'contact'
         : messageContent.viewOnceMessage ? 'view_once'
         : text ? 'text' : 'unknown'

      if (isFromMe) {
         if (!this.config.telegram.features.sendOutgoingMessages) return
         const ownJid = this.whatsappClient?.user?.id || ''
         const ownPhone = ownJid.split(':')[0].split('@')[0]
         msgLog(typeLabel, ownPhone, 'Self', sender, text)
         const topicId = await this.getOrCreateTopic(sender, whatsappMsg, participants)
         if (topicId) await this.syncOutgoingMessage(whatsappMsg, text, topicId, sender)
         return
      }

      await this.createUserMapping(participant, whatsappMsg)
      const topicId = await this.getOrCreateTopic(sender, whatsappMsg, participants)
      if (!topicId) { logger.error(`Failed to get/create topic for ${sender} — message dropped`); return }

      
      const logJid = participant || sender
      const phone = logJid.split('@')[0]
      const name = whatsappMsg.pushName || this.contactMappings.get(phone) || phone
      msgLog(typeLabel, phone, name, sender, text)

      if (messageContent.stickerMessage)            await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId)
      else if (messageContent.ptvMessage)           await this.handleWhatsAppMedia(whatsappMsg, 'video_note', topicId)
      else if (messageContent.videoMessage?.ptv)    await this.handleWhatsAppMedia(whatsappMsg, 'video_note', topicId)
      else if (messageContent.imageMessage)         await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId)
      else if (messageContent.videoMessage)         await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId)
      else if (messageContent.audioMessage)         await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId)
      else if (messageContent.documentMessage)      await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId)
      else if (messageContent.locationMessage)      await this.handleWhatsAppLocation(whatsappMsg, topicId)
      else if (messageContent.contactMessage)       await this.handleWhatsAppContact(whatsappMsg, topicId)
      else if (messageContent.viewOnceMessage)      await this.handleWhatsAppMedia(whatsappMsg, 'view_once', topicId)
      else if (text) {
         let messageText = text
         if (sender.endsWith('@g.us') && participant !== sender) {
            const senderPhone = participant.split('@')[0]
            const senderName = this.contactMappings.get(senderPhone) || whatsappMsg.pushName || senderPhone
            messageText = `${senderName}:\n${text}`
         }
         await this.sendSimpleMessage(topicId, messageText, sender, whatsappMsg.key, whatsappMsg)
      }
   }

   async getOrCreateTopic(chatJid, whatsappMsg, participants = []) {
      
      
      if (this.chatMappings.has(chatJid)) return this.chatMappings.get(chatJid)
      if (this.creatingTopics.has(chatJid)) return await this.creatingTopics.get(chatJid)

      const creationPromise = (async () => {
         const chatId = this.config.telegram.chatId
         if (!chatId) { logger.error('Telegram chat_id not set in config.json'); return null }
         try {
            const isGroup = chatJid.endsWith('@g.us')
            const isStatus = chatJid === 'status@broadcast'
            const isCall = chatJid === 'call@broadcast'
            let topicName, iconColor = 0x7aba3c

            if (isStatus)     { topicName = '📊 Status Updates'; iconColor = 0xff6b35 }
            else if (isCall)  { topicName = '📞 Call Logs'; iconColor = 0xff4757 }
            else if (isGroup) {
               try { const g = await this.whatsappClient.groupMetadata(chatJid); topicName = g.subject } catch { topicName = 'Group Chat' }
               iconColor = 0x6fb9f0
            } else {
               
               const phone = chatJid.split('@')[0]
               const savedName = this.contactMappings.get(phone)
               const pushName = whatsappMsg?.pushName || ''
               if (savedName) topicName = savedName
               else if (pushName && pushName !== phone) topicName = `${pushName} (+${phone})`
               else topicName = `+${phone}`
            }

            const topic = await this.telegramBot.createForumTopic(chatId, topicName, { icon_color: iconColor })

            
            let profilePicUrl = null
            let profilePicBuffer = null
            if (!isStatus && !isCall) {
               try {
                  profilePicUrl = await Promise.race([
                     this.whatsappClient.profilePictureUrl(chatJid, 'image'),
                     new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))
                  ])
               } catch {
                  try {
                     profilePicUrl = await Promise.race([
                        this.whatsappClient.profilePictureUrl(chatJid, 'preview'),
                        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))
                     ])
                  } catch {}
               }
               if (profilePicUrl) {
                  try {
                     const resp = await axios.get(profilePicUrl, { responseType: 'arraybuffer', timeout: 15000 })
                     profilePicBuffer = Buffer.from(resp.data)
                  } catch { profilePicBuffer = null }
               }
            }

            this.chatMappings.set(chatJid, topic.message_thread_id)
            await this.saveMappingsToDb()
            logger.info(`New topic "${topicName}" (ID: ${topic.message_thread_id}) created for ${chatJid}`)

            if (!isStatus && !isCall && this.config.telegram.features.welcomeMessage) {
               await this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup, whatsappMsg, profilePicBuffer, profilePicUrl)
            }
            return topic.message_thread_id
         } catch (error) {
            logger.error(`[TOPIC] FATAL create error for ${chatJid}: ${error?.response?.data?.description || error.message}`, error)
            return null
         } finally {
            this.creatingTopics.delete(chatJid)
         }
      })()

      this.creatingTopics.set(chatJid, creationPromise)
      return await creationPromise
   }

   async sendWelcomeMessage(topicId, jid, isGroup, whatsappMsg, initialProfilePicBuffer = null, initialProfilePicUrl = null) {
      try {
         const chatId = this.config.telegram.chatId
         const phone = jid.split('@')[0]

         const savedName = this.contactMappings.get(phone)
         const pushName = whatsappMsg?.pushName || ''
         const hasPushName = pushName && pushName !== phone

         let welcomeText = ''

         if (isGroup) {
            try {
               const groupMeta = await this.whatsappClient.groupMetadata(jid)
               welcomeText = `*Group Information*\n\nName: ${groupMeta.subject}\nParticipants: ${groupMeta.participants.length}\nGroup ID: \`${jid}\`\nCreated: ${new Date(groupMeta.creation * 1000).toLocaleDateString()}\n\nMessages from this group will appear here.`
            } catch {
               welcomeText = `*Group Chat*\n\nMessages from this group will appear here.`
            }
         } else {
            let userStatus = ''
            
            
            try {
               const statusResult = await Promise.race([
                  this.whatsappClient.fetchStatus(jid),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('fetchStatus timeout')), 4000))
               ])
               if (statusResult?.status) userStatus = `Status: ${statusResult.status}\n`
            } catch {}
            let nameSection = ''
            if (savedName) nameSection += `Name: ${savedName}\n`
            if (hasPushName) nameSection += `Push Name: ${pushName}\n`
            welcomeText = `*Contact Information*\n\n${nameSection}Phone: +${phone}\n${userStatus}WhatsApp ID: \`${jid}\`\nFirst contact: ${new Date().toLocaleDateString()}\n\nMessages with this contact will appear here.`
         }

         
         let picBuffer = initialProfilePicBuffer
         let picUrl = initialProfilePicUrl
         if (!picBuffer) {
            let freshUrl = null
            try {
               freshUrl = await Promise.race([
                  this.whatsappClient.profilePictureUrl(jid, 'image'),
                  new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))
               ])
            } catch {
               
               try {
                  freshUrl = await Promise.race([
                     this.whatsappClient.profilePictureUrl(jid, 'preview'),
                     new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))
                  ])
               } catch {}
            }
            if (freshUrl) {
               picUrl = freshUrl
               try {
                  const resp = await axios.get(freshUrl, { responseType: 'arraybuffer', timeout: 15000 })
                  picBuffer = Buffer.from(resp.data)
               } catch {}
            }
         }

         let sentMessage
         if (picBuffer) {
            
            try {
               sentMessage = await this.telegramBot.sendPhoto(chatId, picBuffer, { message_thread_id: topicId, caption: welcomeText, parse_mode: 'Markdown' })
               if (picUrl) { this.profilePicCache.set(jid, picUrl); await this.saveMappingsToDb() }
            } catch (photoErr) {
               logger.warn(`Welcome photo failed, falling back to text: ${photoErr?.response?.data?.description || photoErr.message}`)
               sentMessage = await this.telegramBot.sendMessage(chatId, welcomeText, { message_thread_id: topicId, parse_mode: 'Markdown' })
            }
         } else {
            sentMessage = await this.telegramBot.sendMessage(chatId, welcomeText, { message_thread_id: topicId, parse_mode: 'Markdown' })
         }
         
         try { await this.telegramBot.pinChatMessage(chatId, sentMessage.message_id) } catch (pinErr) {
            logger.warn('Could not pin welcome message (missing permission?):', pinErr?.response?.data?.description || pinErr.message)
         }
      } catch (error) {
         logger.error(`Welcome message failed for ${jid}: ${error?.response?.data?.description || error.message}`)
      }
   }

   async sendSimpleMessage(topicId, text, sender, whatsappKey = null, whatsappMsg = null) {
      const chatId = this.config.telegram.chatId

      const handleDeletedTopic = async () => {
         logger.warn(`Topic ${topicId} deleted for ${sender} — recreating and resending`)
         this.chatMappings.delete(sender)
         this.profilePicCache.delete(sender)
         await this.saveMappingsToDb()
         const fallbackMsg = whatsappMsg || { key: { remoteJid: sender }, pushName: '', _bridge: {} }
         const newTopicId = await this.getOrCreateTopic(sender, fallbackMsg)
         if (!newTopicId) { logger.error(`Failed to recreate topic for ${sender}`); return null }
         try {
            const retried = await this.telegramBot.sendMessage(chatId, text, { message_thread_id: newTopicId })
            if (whatsappKey && retried?.message_id) {
               this.messageMapping.set(retried.message_id, { whatsappKey, whatsappJid: sender, timestamp: Date.now() })
               this.cleanupMessageMappings()
            }
            return retried?.message_id
         } catch (retryErr) {
            logger.error(`Retry send failed for ${sender}: ${retryErr?.response?.data?.description || retryErr.message}`)
            return null
         }
      }

      try {
         const sentMessage = await this.telegramBot.sendMessage(chatId, text, { message_thread_id: topicId })
         
         if (!sentMessage?.message_thread_id) {
            try { await this.telegramBot.deleteMessage(chatId, sentMessage.message_id) } catch {}
            return await handleDeletedTopic()
         }
         if (whatsappKey && sentMessage.message_id) {
            this.messageMapping.set(sentMessage.message_id, { whatsappKey, whatsappJid: sender, timestamp: Date.now() })
            this.cleanupMessageMappings()
         }
         return sentMessage.message_id
      } catch (error) {
         const desc = error.response?.data?.description || error.message
         if (desc.includes('message thread not found')) return await handleDeletedTopic()
         logger.error(`Failed to send message to Telegram: ${desc}`)
         return null
      }
   }

   cleanupMessageMappings() {
      const maxAge = 24 * 60 * 60 * 1000, now = Date.now()
      for (const [id, data] of this.messageMapping.entries()) { if (now - data.timestamp > maxAge) this.messageMapping.delete(id) }
   }

   

   async handleTelegramMessage(msg) {
      try {
         const topicId = msg.message_thread_id
         const whatsappJid = this.findWhatsAppJidByTopic(topicId)
         if (!whatsappJid) { logger.warn('Could not find WhatsApp chat for Telegram message'); return }

         const userId = msg.from.id
         if (!this.isUserAuthenticated(userId)) {
            await this.telegramBot.sendMessage(msg.chat.id, 'Access denied. Use /password to authenticate.', { message_thread_id: topicId })
            return
         }

         if (msg.reply_to_message?.message_id) {
            const replyMapping = this.messageMapping.get(msg.reply_to_message.message_id)
            if (replyMapping) { await this.handleTelegramReply(msg, whatsappJid, replyMapping); return }
         }

         if (whatsappJid === 'status@broadcast' && msg.reply_to_message) { await this.handleStatusReply(msg); return }

         if (msg.photo)      await this.handleTelegramPhoto(msg, whatsappJid)
         else if (msg.video) await this.handleTelegramVideo(msg, whatsappJid)
         else if (msg.animation) await this.handleTelegramVideo(msg, whatsappJid)
         else if (msg.video_note) await this.handleTelegramVideoNote(msg, whatsappJid)
         else if (msg.voice) await this.handleTelegramVoice(msg, whatsappJid)
         else if (msg.audio) await this.handleTelegramAudio(msg, whatsappJid)
         else if (msg.document) await this.handleTelegramDocument(msg, whatsappJid)
         else if (msg.sticker) await this.handleTelegramSticker(msg, whatsappJid)
         else if (msg.location) await this.handleTelegramLocation(msg, whatsappJid)
         else if (msg.contact) await this.handleTelegramContact(msg, whatsappJid)
         else if (msg.text) await this.handleTelegramText(msg, whatsappJid)

      } catch (error) {
         logger.error('Failed to handle Telegram message:', error.message)
         await this.setReaction(msg.chat.id, msg.message_id, '❌')
      }
   }

   async handleTelegramReply(msg, whatsappJid, replyMapping) {
      try {
         let messageOptions = {}
         const ctx = { stanzaId: replyMapping.whatsappKey.id, participant: replyMapping.whatsappKey.participant || replyMapping.whatsappJid, quotedMessage: { conversation: 'Original message' } }
         if (msg.text) {
            messageOptions = { text: msg.text, contextInfo: ctx }
         } else if (msg.photo) {
            const buffer = await this.downloadTelegramMedia(msg.photo[msg.photo.length - 1].file_id)
            if (buffer) messageOptions = { image: buffer, caption: msg.caption || '', contextInfo: ctx }
         } else if (msg.video || msg.animation) {
            const buffer = await this.downloadTelegramMedia(msg.video?.file_id || msg.animation?.file_id)
            if (buffer) messageOptions = { video: buffer, caption: msg.caption || '', mimetype: 'video/mp4', gifPlayback: !!msg.animation, contextInfo: ctx }
         } else if (msg.document) {
            const buffer = await this.downloadTelegramMedia(msg.document.file_id)
            if (buffer) messageOptions = { document: buffer, mimetype: msg.document.mime_type || 'application/octet-stream', fileName: msg.document.file_name || 'document', caption: msg.caption || '', contextInfo: ctx }
         }
         if (Object.keys(messageOptions).length > 0) {
            const sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)
            if (sendResult?.key?.id) { await this.setReaction(msg.chat.id, msg.message_id, '👍') }
         }
      } catch (error) {
         logger.error('Failed to handle Telegram reply:', error)
         await this.setReaction(msg.chat.id, msg.message_id, '❌')
      }
   }

   async handleTelegramText(msg, whatsappJid) {
      const originalText = msg.text.trim()
      for (const word of this.filters || []) {
         if (originalText.toLowerCase().startsWith(word)) {
            logger.info(`Blocked message due to filter "${word}"`)
            await this.setReaction(msg.chat.id, msg.message_id, '🚫')
            return
         }
      }
      const messageOptions = { text: msg.entities?.some(e => e.type === 'spoiler') ? `🫥 ${originalText}` : originalText }
      let sendResult
      if (this.config.telegram.features.telegramForwardAsAI) {
         sendResult = await this.whatsappClient.sendFromAI?.(whatsappJid, messageOptions.text, null) || await this.whatsappClient.sendMessage(whatsappJid, messageOptions)
      } else if (this.config.telegram.features.telegramForwardAsDisappearing) {
         sendResult = await this.whatsappClient.sendMessage(whatsappJid, { ...messageOptions, ephemeralExpiration: 1234 })
      } else {
         sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)
      }
      if (sendResult?.key?.id) { await this.setReaction(msg.chat.id, msg.message_id, '👍') }
   }

   async handleTelegramPhoto(msg, whatsappJid) {
      try {
         const buffer = await this.downloadTelegramMedia(msg.photo[msg.photo.length - 1].file_id)
         if (buffer) {
            const sendResult = await this.whatsappClient.sendMessage(whatsappJid, { image: buffer, caption: msg.caption || '' })
            if (sendResult?.key?.id) await this.setReaction(msg.chat.id, msg.message_id, '👍')
         }
      } catch (error) { logger.error('Failed to forward photo:', error.message); await this.setReaction(msg.chat.id, msg.message_id, '❌') }
   }

   async handleTelegramVideo(msg, whatsappJid) {
      try {
         const buffer = await this.downloadTelegramMedia(msg.video?.file_id || msg.animation?.file_id)
         if (buffer) {
            const sendResult = await this.whatsappClient.sendMessage(whatsappJid, { video: buffer, caption: msg.caption || '', mimetype: 'video/mp4', gifPlayback: !!msg.animation })
            if (sendResult?.key?.id) await this.setReaction(msg.chat.id, msg.message_id, '👍')
         }
      } catch (error) { logger.error('Failed to forward video:', error.message); await this.setReaction(msg.chat.id, msg.message_id, '❌') }
   }

   async handleTelegramVideoNote(msg, whatsappJid) {
      try {
         const buffer = await this.downloadTelegramMedia(msg.video_note.file_id)
         if (buffer) {
            const sendResult = await this.whatsappClient.sendMessage(whatsappJid, { video: buffer, caption: 'Video Note', mimetype: 'video/mp4', ptv: true })
            if (sendResult?.key?.id) await this.setReaction(msg.chat.id, msg.message_id, '👍')
         }
      } catch (error) { logger.error('Failed to forward video note:', error.message); await this.setReaction(msg.chat.id, msg.message_id, '❌') }
   }

   async handleTelegramVoice(msg, whatsappJid) {
      try {
         const buffer = await this.downloadTelegramMedia(msg.voice.file_id)
         if (buffer) {
            const filePath = path.join(this.tempDir, `voice_${Date.now()}.ogg`)
            await fs.writeFile(filePath, buffer)
            const sendResult = await this.whatsappClient.sendMessage(whatsappJid, { audio: await fs.readFile(filePath), mimetype: 'audio/ogg; codecs=opus', ptt: true })
            await fs.unlink(filePath).catch(() => {})
            if (sendResult?.key?.id) await this.setReaction(msg.chat.id, msg.message_id, '👍')
         }
      } catch (error) { logger.error('Failed to forward voice:', error.message); await this.setReaction(msg.chat.id, msg.message_id, '❌') }
   }

   async handleTelegramAudio(msg, whatsappJid) {
      try {
         const buffer = await this.downloadTelegramMedia(msg.audio.file_id)
         if (buffer) {
            const sendResult = await this.whatsappClient.sendMessage(whatsappJid, { audio: buffer, mimetype: 'audio/mp4', ptt: false })
            if (sendResult?.key?.id) await this.setReaction(msg.chat.id, msg.message_id, '👍')
         }
      } catch (error) { logger.error('Failed to forward audio:', error.message); await this.setReaction(msg.chat.id, msg.message_id, '❌') }
   }

   async handleTelegramDocument(msg, whatsappJid) {
      try {
         const buffer = await this.downloadTelegramMedia(msg.document.file_id)
         if (buffer) {
            const sendResult = await this.whatsappClient.sendMessage(whatsappJid, { document: buffer, mimetype: msg.document.mime_type || 'application/octet-stream', fileName: msg.document.file_name || 'document', caption: msg.caption || '' })
            if (sendResult?.key?.id) await this.setReaction(msg.chat.id, msg.message_id, '👍')
         }
      } catch (error) { logger.error('Failed to forward document:', error.message); await this.setReaction(msg.chat.id, msg.message_id, '❌') }
   }

   async handleTelegramSticker(msg, whatsappJid) {
      try {
         const buffer = await this.downloadTelegramMedia(msg.sticker.file_id)
         if (buffer) {
            const sticker = new Sticker(buffer, { pack: 'Telegram Bridge', author: 'Neoxr Bot', type: StickerTypes.FULL, quality: 50 })
            const sendResult = await this.whatsappClient.sendMessage(whatsappJid, { sticker: await sticker.toBuffer() })
            if (sendResult?.key?.id) await this.setReaction(msg.chat.id, msg.message_id, '👍')
         }
      } catch (error) { logger.error('Failed to forward sticker:', error.message); await this.setReaction(msg.chat.id, msg.message_id, '❌') }
   }

   async handleTelegramLocation(msg, whatsappJid) {
      try {
         const sendResult = await this.whatsappClient.sendMessage(whatsappJid, { location: { degreesLatitude: msg.location.latitude, degreesLongitude: msg.location.longitude } })
         if (sendResult?.key?.id) await this.setReaction(msg.chat.id, msg.message_id, '👍')
      } catch (error) { logger.error('Failed to forward location:', error.message) }
   }

   async handleTelegramContact(msg, whatsappJid) {
      try {
         const c = msg.contact
         const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${c.first_name} ${c.last_name || ''}\nTEL:${c.phone_number}\nEND:VCARD`
         const sendResult = await this.whatsappClient.sendMessage(whatsappJid, { contacts: { displayName: `${c.first_name} ${c.last_name || ''}`, contacts: [{ displayName: `${c.first_name} ${c.last_name || ''}`, vcard }] } })
         if (sendResult?.key?.id) await this.setReaction(msg.chat.id, msg.message_id, '👍')
      } catch (error) { logger.error('Failed to forward contact:', error.message); await this.setReaction(msg.chat.id, msg.message_id, '❌') }
   }

   

   async downloadTelegramMedia(fileId) {
      try {
         const fileInfo = await this.telegramBot.getFile(fileId)
         const response = await axios.get(`https://api.telegram.org/file/bot${this.config.telegram.botToken}/${fileInfo.file_path}`, { responseType: 'arraybuffer', timeout: 30000 })
         return Buffer.from(response.data)
      } catch (error) { logger.error('Failed to download Telegram media:', error); return null }
   }

   async _downloadWhatsAppMediaContent(whatsappMsg) {
      try {
         const m = whatsappMsg.message ?? {}
         const contentType = Object.keys(m).find(k => ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage','viewOnceMessage','ptvMessage'].includes(k))
         if (!contentType) { logger.warn('No supported media type in message:', Object.keys(m)); return null }

         let mediaMessage = m[contentType], actualMediaType = contentType

         if (contentType === 'viewOnceMessage') {
            const innerMsg = m.viewOnceMessage?.message
            const innerType = Object.keys(innerMsg || {}).find(k => ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage','ptvMessage'].includes(k))
            if (!innerType) { logger.warn('No inner media type in viewOnceMessage'); return null }
            mediaMessage = innerMsg[innerType]; actualMediaType = innerType
         }

         if (actualMediaType === 'ptvMessage' || (actualMediaType === 'videoMessage' && mediaMessage?.ptv)) actualMediaType = 'ptv'
         else if (actualMediaType.includes('image'))    actualMediaType = 'image'
         else if (actualMediaType.includes('video'))    actualMediaType = 'video'
         else if (actualMediaType.includes('audio'))    actualMediaType = 'audio'
         else if (actualMediaType.includes('sticker'))  actualMediaType = 'sticker'
         else if (actualMediaType.includes('document')) actualMediaType = 'document'
         else { logger.warn('Unknown media type:', actualMediaType); return null }

         if (!mediaMessage?.mediaKey) { logger.error('Missing mediaKey for', actualMediaType); return null }

         const stream = await downloadContentFromMessage(mediaMessage, actualMediaType)
         let buffer = Buffer.alloc(0)
         for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk])
         if (!buffer || buffer.length === 0) throw new Error(`Empty buffer for ${actualMediaType}`)

         return { buffer, mimetype: mediaMessage.mimetype, filename: mediaMessage.fileName || `media-${Date.now()}.${mime.extension(mediaMessage.mimetype) || 'bin'}` }
      } catch (error) { logger.error(`Failed to download WA media: ${error.message}`); return null }
   }

   async handleWhatsAppMedia(whatsappMsg, mediaTypeHint, topicId, isOutgoing = false) {
      const sendMedia = async (finalTopicId) => {
         try {
            let mediaMessage, fileName = `media_${Date.now()}`, caption = this.extractText(whatsappMsg)
            const sender = whatsappMsg.key.remoteJid

            switch (mediaTypeHint) {
               case 'image':      mediaMessage = whatsappMsg.message.imageMessage; fileName += '.jpg'; break
               case 'video':      mediaMessage = whatsappMsg.message.videoMessage; fileName += '.mp4'; break
               case 'video_note': mediaMessage = whatsappMsg.message.ptvMessage || whatsappMsg.message.videoMessage; fileName += '.mp4'; break
               case 'audio':      mediaMessage = whatsappMsg.message.audioMessage; fileName += '.ogg'; break
               case 'document':   mediaMessage = whatsappMsg.message.documentMessage; fileName = mediaMessage.fileName || `document_${Date.now()}`; break
               case 'sticker':    mediaMessage = whatsappMsg.message.stickerMessage; fileName += '.webp'; break
               case 'view_once': {
                  const innerMsg = whatsappMsg.message.viewOnceMessage?.message
                  const innerType = Object.keys(innerMsg || {}).find(k => ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage','ptvMessage'].includes(k))
                  if (!innerType) throw new Error('No inner media type in viewOnceMessage')
                  mediaMessage = innerMsg[innerType]; mediaTypeHint = innerType.replace('Message', '')
                  fileName += `.${mime.extension(mediaMessage.mimetype) || 'bin'}`; break
               }
            }

            if (!mediaMessage) return logger.error(`No media content for ${mediaTypeHint}`)
            const mediaData = await this._downloadWhatsAppMediaContent(whatsappMsg)
            if (!mediaData?.buffer) throw new Error('Failed to download media from WhatsApp')

            const filePath = path.join(this.tempDir, mediaData.filename)
            await fs.writeFile(filePath, mediaData.buffer)

            const chatId = this.config.telegram.chatId
            if (isOutgoing) caption = caption ? `You: ${caption}` : 'You sent media'
            else if (sender.endsWith('@g.us') && whatsappMsg.key.participant !== sender) {
               const senderPhone = whatsappMsg.key.participant.split('@')[0]
               caption = `${this.contactMappings.get(senderPhone) || whatsappMsg.pushName || senderPhone}:\n${caption || ''}`
            }

            const opts = { caption, message_thread_id: finalTopicId }
            let sentMessage
            const storeMapping = (m) => { if (m?.message_id && whatsappMsg.key) this.messageMapping.set(m.message_id, { whatsappKey: whatsappMsg.key, whatsappJid: whatsappMsg.key.remoteJid, timestamp: Date.now() }) }

            switch (mediaTypeHint) {
               case 'image':      sentMessage = await this.telegramBot.sendPhoto(chatId, filePath, opts); break
               case 'video':      sentMessage = mediaMessage.gifPlayback ? await this.telegramBot.sendAnimation(chatId, filePath, opts) : await this.telegramBot.sendVideo(chatId, filePath, opts); break
               case 'ptv':
               case 'video_note': {
                  const notePath = await this.convertToVideoNote(filePath)
                  sentMessage = await this.telegramBot.sendVideoNote(chatId, notePath, { message_thread_id: finalTopicId })
                  if (notePath !== filePath) await fs.unlink(notePath).catch(() => {}); break
               }
               case 'audio':      sentMessage = mediaMessage.ptt ? await this.telegramBot.sendVoice(chatId, filePath, opts) : await this.telegramBot.sendAudio(chatId, filePath, { ...opts, title: mediaMessage.title || 'Audio' }); break
               case 'document':   sentMessage = await this.telegramBot.sendDocument(chatId, filePath, opts); break
               case 'sticker':
                  try { sentMessage = await this.telegramBot.sendSticker(chatId, filePath, { message_thread_id: finalTopicId }) }
                  catch {
                     const pngPath = filePath.replace('.webp', '.png')
                     await sharp(filePath).png().toFile(pngPath)
                     sentMessage = await this.telegramBot.sendPhoto(chatId, pngPath, { caption: caption || 'Sticker', message_thread_id: finalTopicId })
                     await fs.unlink(pngPath).catch(() => {})
                  }
                  break
            }
            
            if (!sentMessage?.message_thread_id) {
               logger.warn(`Topic ${finalTopicId} deleted for ${whatsappMsg.key.remoteJid} (media) — recreating`)
               try { await this.telegramBot.deleteMessage(chatId, sentMessage.message_id) } catch {}
               await fs.unlink(filePath).catch(() => {})
               throw Object.assign(new Error('message thread not found'), { _silent: true })
            }
            storeMapping(sentMessage)
            await fs.unlink(filePath).catch(() => {})

         } catch (error) {
            const desc = error.response?.data?.description || error.message
            if (desc.includes('message thread not found') || error._silent) {
               const sender = whatsappMsg.key.remoteJid
               logger.warn(`Topic ${finalTopicId} deleted for ${sender} (media) — recreating`)
               this.chatMappings.delete(sender); this.profilePicCache.delete(sender)
               await this.saveMappingsToDb()
               const newTopicId = await this.getOrCreateTopic(sender, whatsappMsg)
               if (newTopicId) await sendMedia(newTopicId)
               else logger.error(`Failed to recreate topic for ${sender}`)
            } else { logger.error(`Failed to send ${mediaTypeHint}: ${desc}`) }
         }
      }
      await sendMedia(topicId)
   }

   async convertToVideoNote(inputPath) {
      return new Promise((resolve) => {
         const outputPath = inputPath.replace('.mp4', '_note.mp4')
         ffmpeg(inputPath).videoFilter('scale=240:240:force_original_aspect_ratio=increase,crop=240:240').duration(60).format('mp4')
            .on('end', () => resolve(outputPath)).on('error', () => resolve(inputPath)).save(outputPath)
      })
   }

   async setReaction(chatId, messageId, emoji) {
      try {
         await axios.post(`https://api.telegram.org/bot${this.config.telegram.botToken}/setMessageReaction`, { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] })
      } catch (err) { logger.warn('Failed to set reaction:', err?.response?.data?.description || err.message) }
   }

   findWhatsAppJidByTopic(topicId) {
      for (const [jid, topicData] of this.chatMappings.entries()) {
         const id = typeof topicData === 'object' && topicData !== null ? topicData.telegramTopicId : topicData
         if (id === topicId) return jid
      }
      return null
   }

   

   async syncContacts() {
      try {
         
         
         
         
         
         
         
         await this.saveMappingsToDb()
         await this.updateTopicNames()
      } catch (error) { logger.error('Failed to sync contacts:', error) }
   }

   async updateTopicNames() {
      try {
         const chatId = this.config.telegram.chatId
         if (!chatId) return
         let updatedCount = 0
         for (const [jid, topicId] of this.chatMappings.entries()) {
            if (!jid.endsWith('@g.us') && jid !== 'status@broadcast' && jid !== 'call@broadcast') {
               const phone = jid.split('@')[0]
               const contactName = this.contactMappings.get(phone)
               if (contactName) {
                  const newName = contactName
                  try { await this.telegramBot.editForumTopic(chatId, topicId, { name: newName }); updatedCount++ } catch (e) { logger.error(`Failed to update topic ${topicId}:`, e.message) }
                  await new Promise(r => setTimeout(r, 200))
               }
            }
         }
      } catch (error) { logger.error('Failed to update topic names:', error) }
   }

   

   async handleStatusMessage(whatsappMsg, text, participants = [], resolvedParticipant = null) {
      try {
         if (!this.config.telegram.features.statusSync) return
         
         const participantJid = resolvedParticipant
            || resolveLid(this.whatsappClient, whatsappMsg.key.participant || '', participants, whatsappMsg.key.participantAlt)
         const phone = participantJid ? participantJid.split('@')[0] : null
         const savedName = phone ? this.contactMappings.get(phone) : null
         const contactName = savedName || whatsappMsg.pushName || null

         const topicId = await this.getOrCreateTopic('status@broadcast', whatsappMsg)
         if (!topicId) return

         let statusText
         if (contactName && phone && !phone.includes('@')) {
            statusText = `*Status from ${contactName}* (+${phone})`
         } else if (phone && !phone.includes('@')) {
            statusText = `*Status from +${phone}*`
         } else {
            statusText = `*Status Update*`
         }
         if (text) statusText += `\n\n${text}`

         const chatId = this.config.telegram.chatId
         const mediaType = this.getMediaType(whatsappMsg)
         if (mediaType && mediaType !== 'text') {
            await this.forwardStatusMedia(whatsappMsg, topicId, statusText, mediaType)
         } else {
            const sentMsg = await this.telegramBot.sendMessage(chatId, statusText, { message_thread_id: topicId, parse_mode: 'Markdown' })
            this.statusMessageMapping.set(sentMsg.message_id, whatsappMsg.key)
         }
      } catch (error) {
         const desc = error.response?.data?.description || error.message
         if (desc.includes('message thread not found')) {
            this.chatMappings.delete('status@broadcast'); this.profilePicCache.delete('status@broadcast')
            await this.saveMappingsToDb()
            await this.handleStatusMessage(whatsappMsg, text, participants, resolvedParticipant)
         } else { logger.error('Error handling status:', error) }
      }
   }

   async forwardStatusMedia(whatsappMsg, topicId, caption, mediaType) {
      try {
         const mediaData = await this._downloadWhatsAppMediaContent(whatsappMsg)
         if (!mediaData?.buffer) throw new Error('Failed to download status media')
         const chatId = this.config.telegram.chatId
         let sentMsg
         switch (mediaType) {
            case 'image': sentMsg = await this.telegramBot.sendPhoto(chatId, mediaData.buffer, { message_thread_id: topicId, caption, parse_mode: 'Markdown' }); break
            case 'video': sentMsg = await this.telegramBot.sendVideo(chatId, mediaData.buffer, { message_thread_id: topicId, caption, parse_mode: 'Markdown' }); break
            case 'audio': sentMsg = await this.telegramBot.sendAudio(chatId, mediaData.buffer, { message_thread_id: topicId, caption, parse_mode: 'Markdown' }); break
         }
         if (sentMsg) this.statusMessageMapping.set(sentMsg.message_id, whatsappMsg.key)
      } catch (error) {
         const desc = error.response?.data?.description || error.message
         if (desc.includes('message thread not found')) {
            this.chatMappings.delete('status@broadcast'); this.profilePicCache.delete('status@broadcast')
            await this.saveMappingsToDb()
            const newTopicId = await this.getOrCreateTopic('status@broadcast', whatsappMsg)
            if (newTopicId) await this.forwardStatusMedia(whatsappMsg, newTopicId, caption, mediaType)
         } else { logger.error('Error forwarding status media:', error) }
      }
   }

   getMediaType(msg) {
      if (msg.message?.imageMessage) return 'image'
      if (msg.message?.videoMessage) return 'video'
      if (msg.message?.audioMessage) return 'audio'
      if (msg.message?.documentMessage) return 'document'
      if (msg.message?.stickerMessage) return 'sticker'
      if (msg.message?.locationMessage) return 'location'
      if (msg.message?.contactMessage) return 'contact'
      return 'text'
   }

   

   async handleWhatsAppLocation(whatsappMsg, topicId) {
      const send = async (finalTopicId) => {
         try {
            const chatId = this.config.telegram.chatId
            const loc = whatsappMsg.message.locationMessage
            const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid
            const phone = participant.split('@')[0]
            const senderName = this.contactMappings.get(phone) || whatsappMsg.pushName || `+${phone}`
            const isGroup = whatsappMsg.key.remoteJid.endsWith('@g.us')
            let caption = 'Location'
            if (isGroup && participant !== whatsappMsg.key.remoteJid) caption = `${senderName} shared a location`
            await this.telegramBot.sendLocation(chatId, loc.degreesLatitude, loc.degreesLongitude, { message_thread_id: finalTopicId })
            if (loc.name || loc.address) {
               let info = caption
               if (loc.name) info += `\n${loc.name}`
               if (loc.address) info += `\n📍 ${loc.address}`
               await this.telegramBot.sendMessage(chatId, info, { message_thread_id: finalTopicId })
            }
         } catch (error) {
            const desc = error.response?.data?.description || error.message
            if (desc.includes('message thread not found')) {
               const sender = whatsappMsg.key.remoteJid
               this.chatMappings.delete(sender); this.profilePicCache.delete(sender)
               await this.saveMappingsToDb()
               const newTopicId = await this.getOrCreateTopic(sender, whatsappMsg)
               if (newTopicId) await send(newTopicId)
            } else { logger.error('Failed to handle location:', desc) }
         }
      }
      await send(topicId)
   }

   async handleWhatsAppContact(whatsappMsg, topicId) {
      const send = async (finalTopicId) => {
         try {
            const chatId = this.config.telegram.chatId
            const contactMsg = whatsappMsg.message.contactMessage
            const participant = whatsappMsg.key.participant || whatsappMsg.key.remoteJid
            const phone = participant.split('@')[0]
            const senderName = this.contactMappings.get(phone) || whatsappMsg.pushName || `+${phone}`
            const isGroup = whatsappMsg.key.remoteJid.endsWith('@g.us')
            let caption = `Contact: ${contactMsg.displayName}`
            if (isGroup && participant !== whatsappMsg.key.remoteJid) caption = `${senderName} shared a contact:\n${contactMsg.displayName}`
            if (contactMsg.vcard) {
               const m = contactMsg.vcard.match(/TEL[^:]*:([^\n\r]+)/i)
               if (m) caption += `\n${m[1].trim()}`
            }
            await this.telegramBot.sendMessage(chatId, caption, { message_thread_id: finalTopicId })
         } catch (error) {
            const desc = error.response?.data?.description || error.message
            if (desc.includes('message thread not found')) {
               const sender = whatsappMsg.key.remoteJid
               this.chatMappings.delete(sender); this.profilePicCache.delete(sender)
               await this.saveMappingsToDb()
               const newTopicId = await this.getOrCreateTopic(sender, whatsappMsg)
               if (newTopicId) await send(newTopicId)
            } else { logger.error('Failed to handle contact:', desc) }
         }
      }
      await send(topicId)
   }

   

   async syncOutgoingMessage(whatsappMsg, text, topicId, sender) {
      if (!this.config.telegram.features.sendOutgoingMessages) return
      try {
         const m = whatsappMsg.message || {}
         if (m.stickerMessage)         await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId, true)
         else if (m.ptvMessage)        await this.handleWhatsAppMedia(whatsappMsg, 'video_note', topicId, true)
         else if (m.videoMessage?.ptv) await this.handleWhatsAppMedia(whatsappMsg, 'video_note', topicId, true)
         else if (m.imageMessage)      await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId, true)
         else if (m.videoMessage)      await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId, true)
         else if (m.audioMessage)      await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId, true)
         else if (m.documentMessage)   await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId, true)
         else if (m.locationMessage)   await this.handleWhatsAppLocation(whatsappMsg, topicId)
         else if (m.contactMessage)    await this.handleWhatsAppContact(whatsappMsg, topicId)
         else if (m.viewOnceMessage)   await this.handleWhatsAppMedia(whatsappMsg, 'view_once', topicId, true)
         else if (text)                await this.sendSimpleMessage(topicId, `📤 You: ${text}`, sender)
      } catch (error) { logger.error('Failed to sync outgoing message:', error) }
   }

   

   async handleStatusReply(msg) {
      try {
         const originalStatusKey = this.statusMessageMapping.get(msg.reply_to_message.message_id)
         if (!originalStatusKey) { await this.telegramBot.sendMessage(msg.chat.id, 'Could not find the original status.', { message_thread_id: msg.message_thread_id }); return }
         const phone = originalStatusKey.participant?.split('@')[0] || ''
         const contactName = this.contactMappings.get(phone) || `+${phone}`
         const sendResult = await this.whatsappClient.sendMessage(originalStatusKey.participant, {
            text: msg.text,
            contextInfo: { quotedMessage: originalStatusKey.message, stanzaId: originalStatusKey.id, participant: originalStatusKey.participant, remoteJid: 'status@broadcast' },
         })
         if (sendResult?.key?.id) {
            await this.telegramBot.sendMessage(msg.chat.id, `Reply sent to ${contactName}.`, { message_thread_id: msg.message_thread_id })
            await this.setReaction(msg.chat.id, msg.message_id, '✅')
         } else throw new Error('Failed to send status reply')
      } catch (error) { logger.error('Failed to handle status reply:', error); await this.setReaction(msg.chat.id, msg.message_id, '❌') }
   }

   async createUserMapping(participant, whatsappMsg) {
      if (this.userMappings.has(participant)) {
         const userData = this.userMappings.get(participant)
         userData.messageCount = (userData.messageCount || 0) + 1
         this.userMappings.set(participant, userData)
         await this.saveMappingsToDb()
         return
      }
      const _p = participant.split('@')[0]
      this.userMappings.set(participant, { name: this.contactMappings.get(_p) || whatsappMsg?.pushName || null, phone: _p, firstSeen: new Date(), messageCount: 1 })
      await this.saveMappingsToDb()
   }

   

   async handleCallNotification(callEvent) {
      if (!this.telegramBot || !this.config.telegram.features.callLogs) return
      const callKey = `${callEvent.from}_${callEvent.id}`
      if (this.activeCallNotifications.has(callKey)) return
      this.activeCallNotifications.set(callKey, true)
      setTimeout(() => { this.activeCallNotifications.delete(callKey) }, 30000)
      try {
         
         const resolvedFrom = resolveLid(this.whatsappClient, callEvent.from || '')
         const phone = resolvedFrom.split('@')[0]
         const callerName = this.contactMappings.get(phone) || null
         const displayName = callerName ? `${callerName} (+${phone})` : `+${phone}`
         const topicId = await this.getOrCreateTopic('call@broadcast', { key: { remoteJid: 'call@broadcast', participant: resolvedFrom } })
         if (!topicId) return
         const callType = callEvent.isVideo ? "Video Call" : "Voice Call"
         const callStatusLabel = callEvent.status === "offer" ? "Incoming" : callEvent.status === "terminate" ? "Ended" : callEvent.status === "relaylatency" ? "Connecting" : callEvent.status || "Incoming"
         const callTime = callEvent.date ? new Date(callEvent.date).toLocaleString() : new Date().toLocaleString()
         const callEmoji = callEvent.isVideo ? "📹" : "📞"
         const callText = `*${callType}*\n\nFrom: ${displayName}\nNumber: +${phone}\nTime: ${callTime}\nStatus: ${callStatusLabel}\nType: ${callEvent.isGroup ? "Group Call" : "Direct Call"}\nCall ID: \`${callEvent.id || "N/A"}\``
         try {
            await this.telegramBot.sendMessage(this.config.telegram.chatId, callText,
               { message_thread_id: topicId, parse_mode: 'Markdown' })
         } catch (sendErr) {
            const desc = sendErr.response?.data?.description || sendErr.message
            if (desc.includes('message thread not found')) {
               this.chatMappings.delete('call@broadcast'); this.profilePicCache.delete('call@broadcast')
               await this.saveMappingsToDb()
               const newTopicId = await this.getOrCreateTopic('call@broadcast', { key: { remoteJid: 'call@broadcast', participant: resolvedFrom } })
               if (newTopicId) {
                  await this.telegramBot.sendMessage(this.config.telegram.chatId, callText,
                     { message_thread_id: newTopicId, parse_mode: 'Markdown' })
               } else { logger.error('Failed to recreate call@broadcast topic') }
            } else { throw sendErr }
         }
      } catch (error) { logger.error('Error handling call notification:', error) }
   }

   

   async sendProfilePicture(topicId, jid, isUpdate = false) {
      try {
         if (!this.config.telegram.features.profilePicSync) return
         let currentUrl = null
         try { currentUrl = await this.whatsappClient.profilePictureUrl(jid, 'image') } catch {}
         const cached = this.profilePicCache.get(jid)
         const extractId = (url) => { if (!url) return null; try { return new URL(url).pathname } catch { return url.split('?')[0] } }
         if (extractId(currentUrl) === extractId(cached)) return
         if (currentUrl) {
            await this.telegramBot.sendPhoto(this.config.telegram.chatId, currentUrl, { message_thread_id: topicId, caption: isUpdate ? 'Profile picture updated' : 'Profile Picture' })
            this.profilePicCache.set(jid, currentUrl)
            await this.saveMappingsToDb()
         }
      } catch (error) { logger.error(`Could not send profile picture for ${jid}:`, error) }
   }

   

   async sendStartMessage() {
      try {
         if (!this.telegramBot) return
         const startMessage =
            `*Bridge Started*\n\n` +
            `*Contacts:* ${this.contactMappings.size} synced\n` +
            `*Chats:* ${this.chatMappings.size} mapped\n\n`
         for (const sudoId of this.sudoUsers) {
            try { await this.telegramBot.sendMessage(sudoId, startMessage, { parse_mode: 'Markdown' }) } catch {}
         }
         logger.info('Start message sent to Telegram')
      } catch (error) { logger.error('Failed to send start message:', error) }
   }

   

   async setupWhatsAppHandlers() {
      if (!this.whatsappClient) { logger.warn('WhatsApp client not available'); return }

      
      
      this.whatsappClient.ev.on('messaging-history.set', async ({ contacts }) => {
         try {
            if (!Array.isArray(contacts) || contacts.length === 0) return
            let newCount = 0
            for (const contact of contacts) {
               if (!contact?.id) continue
               const phone = contact.id.split('@')[0]
               const contactName = contact.name || contact.notify || contact.verifiedName
               if (contactName && contactName !== phone && !contactName.startsWith('+') && contactName.length > 2 && this.contactMappings.get(phone) !== contactName) {
                  this.contactMappings.set(phone, contactName); newCount++
               }
            }
            if (newCount > 0) {
               await this.saveMappingsToDb()
               await this.updateTopicNames()
               logger.info(`Synced ${newCount} contacts from WhatsApp history sync`)
            }
         } catch (error) { logger.error('Failed to process history sync contacts:', error) }
      })

      this.whatsappClient.ev.on('contacts.update', async (contacts) => {
         try {
            let updatedCount = 0
            for (const contact of contacts) {
               if (contact.id && contact.name) {
                  const phone = contact.id.split('@')[0]
                  const oldName = this.contactMappings.get(phone)
                  if (contact.name !== phone && !contact.name.startsWith('+') && contact.name.length > 2 && oldName !== contact.name) {
                     this.contactMappings.set(phone, contact.name); updatedCount++
                     if (this.chatMappings.has(contact.id)) {
                        const topicId = this.chatMappings.get(contact.id)
                        try { await this.telegramBot.editForumTopic(this.config.telegram.chatId, topicId, { name: contact.name }) } catch {}
                     }
                  }
               }
               if (contact.id && this.chatMappings.has(contact.id)) await this.sendProfilePicture(this.chatMappings.get(contact.id), contact.id, true)
            }
            if (updatedCount > 0) await this.saveMappingsToDb()
         } catch (error) { logger.error('Failed to process contact updates:', error) }
      })

      this.whatsappClient.ev.on('contacts.upsert', async (contacts) => {
         try {
            let newCount = 0
            for (const contact of contacts) {
               if (contact.id && contact.name) {
                  const phone = contact.id.split('@')[0]
                  if (contact.name !== phone && !contact.name.startsWith('+') && contact.name.length > 2 && !this.contactMappings.has(phone)) {
                     this.contactMappings.set(phone, contact.name); newCount++
                     if (this.chatMappings.has(contact.id)) {
                        const topicId = this.chatMappings.get(contact.id)
                        try { await this.telegramBot.editForumTopic(this.config.telegram.chatId, topicId, { name: contact.name }) } catch {}
                     }
                  }
               }
            }
            if (newCount > 0) await this.saveMappingsToDb()
         } catch (error) { logger.error('Failed to process new contacts:', error) }
      })

      this.whatsappClient.ev.on('call', async (callEvents) => {
         for (const callEvent of callEvents) await this.handleCallNotification(callEvent)
      })

   }

   

   extractText(msg) {
      return (
         msg.message?.conversation ||
         msg.message?.extendedTextMessage?.text ||
         msg.message?.imageMessage?.caption ||
         msg.message?.videoMessage?.caption ||
         msg.message?.documentMessage?.caption ||
         msg.message?.audioMessage?.caption ||
         ''
      )
   }

   async shutdown() {
      logger.info('Shutting down Telegram bridge...')
      try { await this.saveMappingsToDb() } catch {}
      if (this.telegramBot) { try { await this.telegramBot.stopPolling() } catch {} }
      try {
         const tmpFiles = await fs.readdir(this.tempDir)
         for (const file of tmpFiles) await fs.unlink(path.join(this.tempDir, file)).catch(() => {})
      } catch {}
      logger.info('Telegram bridge shutdown complete.')
   }
}
