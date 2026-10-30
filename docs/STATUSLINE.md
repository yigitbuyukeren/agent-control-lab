# Claude Code kota toplayıcısı (isteğe bağlı)

`statusline-collect`, Claude Code'un statusLine komutuna verdiği JSON'dan yalnızca 5 saatlik ve 7 günlük
kullanım yüzdelerini, reset zamanlarını ve güncelleme zamanını yerel bir önbelleğe yazar. Ham JSON,
oturum bilgisi ve kimlik verileri saklanmaz. Proje hiçbir ayar dosyasını kendiliğinden değiştirmez.

## Kurulum (kendi ayarına sen eklersin)

`~/.claude/settings.json` içine:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /MUTLAK/YOL/agent-control-lab/apps/cli/bin/agent-control-lab.js statusline-collect"
  }
}
```

Toplayıcı stdout'a bir şey yazmaz, yani durum çubuğu boş kalır. Zaten bir statusLine betiğin varsa, aynı
girdiyi ikisine de ver:

```bash
input=$(cat)
printf '%s' "$input" | node /MUTLAK/YOL/agent-control-lab/apps/cli/bin/agent-control-lab.js statusline-collect
printf '%s' "$input" | ./senin-betigin.sh
```

## Okuma

```bash
pnpm cli quota claude
```

Veri 15 dakikadan eskiyse, eksikse, bozuksa veya pencerenin reset zamanı geçmişse ilgili alan `unknown`
görünür.

## Önbellek

- macOS: `~/Library/Caches/agent-control-lab/`
- Linux: `$XDG_CACHE_HOME` veya `~/.cache/agent-control-lab/`
- Windows: `%LOCALAPPDATA%\agent-control-lab\`
- `ACL_CACHE_DIR` ile değiştirilebilir. Dizin yalnızca sahibine açık oluşturulur, dosya atomik yazılır.
