$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectRoot 'test-results'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice = $speaker.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'ja-JP' } | Select-Object -First 1
    if (-not $voice) { throw 'No installed Japanese system voice.' }
    $speaker.SelectVoice($voice.VoiceInfo.Name)
    $wavePath = Join-Path $outputDirectory 'japanese-speech-sample.wav'
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $speaker.SetOutputToWaveFile($wavePath, $format)
    # Unicode escape avoids Windows PowerShell script-encoding differences.
    $text = -join ([int[]](0x3053,0x3093,0x306b,0x3061,0x306f,0x3002,0x99c5,0x306f,0x3069,0x3053,0x3067,0x3059,0x304b,0x3002,0x3082,0x3046,0x4e00,0x5ea6,0x304a,0x9858,0x3044,0x3057,0x307e,0x3059,0x3002) | ForEach-Object { [char]$_ })
    $speaker.Speak($text)
    $speaker.SetOutputToNull()
    $result = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/speech/transcribe' -Method Post -ContentType 'audio/wav' -Body ([System.IO.File]::ReadAllBytes($wavePath))
    if (-not $result.text) { throw 'The local recognizer returned no text.' }
    $result | ConvertTo-Json
} finally { $speaker.Dispose() }
