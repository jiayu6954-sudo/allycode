$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
    function Await($operation, [Type]$type) {
        $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
        $task.GetAwaiter().GetResult()
    }
    function AwaitAction($operation) {
        $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and !$_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
        $task = $method.Invoke($null, @($operation))
        $task.GetAwaiter().GetResult()
    }
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
    if ($request.action -eq 'status') {
        @{ available = ($languages.Count -gt 0); languages = $languages; maxImageDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension; engine = 'windows-ocr'; pdf = $true } | ConvertTo-Json -Depth 8 -Compress
        exit 0
    }
    if ($request.language) {
        $language = New-Object Windows.Globalization.Language($request.language)
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    } else { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if (!$engine) { throw 'Requested OCR language is unavailable. Check document_ocr status and install the Windows language OCR component.' }
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($request.path)) ([Windows.Storage.StorageFile])
    $isPdf = [IO.Path]::GetExtension($request.path).ToLowerInvariant() -eq '.pdf'
    $stream = $null
    try {
        if ($isPdf) {
            $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
            $totalPages = [int]$pdf.PageCount
        } else {
            $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $totalPages = [int]$decoder.FrameCount
        }
        $first = [int]$request.startPage
        $last = [Math]::Min([int]$request.endPage, $totalPages)
        if ($first -lt 1 -or $first -gt $totalPages -or $last -lt $first -or $last-$first -ge 10) { throw 'Invalid page range; maximum 10 pages per call.' }
        $segments = [System.Collections.Generic.List[object]]::new()
        $pages = [System.Collections.Generic.List[object]]::new()
        for ($number=$first; $number -le $last; $number++) {
            $pageStream = $null; $pdfPage = $null; $bitmap = $null
            try {
                if ($isPdf) {
                    $pdfPage = $pdf.GetPage([uint32]($number-1))
                    $pageStream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
                    $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
                    $scale = [Math]::Min(2.5, ([Windows.Media.Ocr.OcrEngine]::MaxImageDimension - 1) / [Math]::Max($pdfPage.Size.Width, $pdfPage.Size.Height))
                    $options.DestinationWidth = [uint32]($pdfPage.Size.Width * $scale)
                    $options.DestinationHeight = [uint32]($pdfPage.Size.Height * $scale)
                    $null = AwaitAction ($pdfPage.RenderToStreamAsync($pageStream, $options))
                    $pageStream.Seek(0)
                    $pageDecoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($pageStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
                    $frame = Await ($pageDecoder.GetFrameAsync(0)) ([Windows.Graphics.Imaging.BitmapFrame])
                } else {
                    $frame = Await ($decoder.GetFrameAsync([uint32]($number-1))) ([Windows.Graphics.Imaging.BitmapFrame])
                }
                if ($frame.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $frame.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'Image exceeds OCR maximum size; split into regions before recognition. No silent downsampling performed.' }
                $bitmap = Await ($frame.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
                $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
                $lineNumber = 0
                foreach ($line in $result.Lines) {
                    $lineNumber++
                    $words = @($line.Words | ForEach-Object { @{text=$_.Text; x=$_.BoundingRect.X; y=$_.BoundingRect.Y; width=$_.BoundingRect.Width; height=$_.BoundingRect.Height} })
                    $segments.Add(@{locator="page:${number}:ocr:line:${lineNumber}";page=$number;text=$line.Text;words=$words;method='windows-ocr';reviewed=$false})
                }
                $pages.Add(@{page=$number;width=$bitmap.PixelWidth;height=$bitmap.PixelHeight;lines=$lineNumber;blankOrUnrecognized=($lineNumber -eq 0)})
            } finally {
                if ($bitmap) { $bitmap.Dispose() }
                if ($pageStream) { $pageStream.Dispose() }
                if ($pdfPage) { $pdfPage.Dispose() }
            }
        }
        @{method='windows-ocr';language=$engine.RecognizerLanguage.LanguageTag;totalPages=$totalPages;processedPages=@($first..$last);pages=@($pages.ToArray());segments=@($segments.ToArray());reviewed=$false;notice='OCR text and word boxes require verification; empty pages may be blank or unrecognized. No confidence score is provided.'} | ConvertTo-Json -Depth 12 -Compress
    } finally { if ($stream) { $stream.Dispose() } }
} catch {
    @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress
    exit 2
}
