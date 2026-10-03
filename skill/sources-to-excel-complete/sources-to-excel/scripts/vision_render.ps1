$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    Add-Type -AssemblyName System.Drawing
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
    function Await($operation, [Type]$type) {
        $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
        $task.GetAwaiter().GetResult()
    }
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $page = [int]$request.page
    if ($page -lt 1) { throw 'Invalid page' }
    $inputStream=$null; $image=$null; $pdfPage=$null; $bitmap=$null; $graphics=$null; $output=$null; $random=$null
    try {
        if ([IO.Path]::GetExtension($request.path).ToLowerInvariant() -eq '.pdf') {
            $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($request.path)) ([Windows.Storage.StorageFile])
            $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
            $totalPages = [int]$pdf.PageCount
            if ($page -gt $totalPages) { throw 'Page exceeds PDF page count' }
            $pdfPage = $pdf.GetPage([uint32]($page-1))
            $random = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
            $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
            $scale = [Math]::Min([double]3, [double]4096 / [Math]::Max($pdfPage.Size.Width,$pdfPage.Size.Height))
            $options.DestinationWidth=[uint32]($pdfPage.Size.Width*$scale)
            $options.DestinationHeight=[uint32]($pdfPage.Size.Height*$scale)
            $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and !$_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
            $task=$method.Invoke($null,@($pdfPage.RenderToStreamAsync($random,$options)))
            $null=$task.GetAwaiter().GetResult()
            $random.Seek(0)
            $inputStream=[System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($random)
            $image=[Drawing.Image]::FromStream($inputStream)
        } else {
            $inputStream=[IO.File]::OpenRead($request.path)
            $image=[Drawing.Image]::FromStream($inputStream)
            $frameDimension=New-Object Drawing.Imaging.FrameDimension($image.FrameDimensionsList[0])
            $totalPages=$image.GetFrameCount($frameDimension)
            if ($page -gt $totalPages) { throw 'Page exceeds image frame count' }
            $null=$image.SelectActiveFrame($frameDimension,$page-1)
        }
        if ([long]$image.Width*$image.Height -gt 80000000) { throw 'Image exceeds 80 megapixels; split source first' }
        $sourceWidth=$image.Width; $sourceHeight=$image.Height
        $rect=New-Object Drawing.Rectangle(0,0,$sourceWidth,$sourceHeight)
        if ($request.region) {
            $r=$request.region
            if ($r.x -lt 0 -or $r.y -lt 0 -or $r.width -le 0 -or $r.height -le 0 -or $r.x+$r.width -gt 1.00001 -or $r.y+$r.height -gt 1.00001) { throw 'Region must be contained within normalized image coordinates' }
            $rect=New-Object Drawing.Rectangle([int]($r.x*$sourceWidth),[int]($r.y*$sourceHeight),[Math]::Max(1,[int]($r.width*$sourceWidth)),[Math]::Max(1,[int]($r.height*$sourceHeight)))
        }
        $scale=[Math]::Min([double]1,[double]2048/[Math]::Max($rect.Width,$rect.Height))
        $width=[Math]::Max(1,[int]($rect.Width*$scale)); $height=[Math]::Max(1,[int]($rect.Height*$scale))
        $bitmap=New-Object Drawing.Bitmap($width,$height)
        $graphics=[Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([Drawing.Color]::White)
        $graphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $dest=New-Object Drawing.Rectangle(0,0,$width,$height)
        $graphics.DrawImage($image,$dest,$rect,[Drawing.GraphicsUnit]::Pixel)
        $output=New-Object IO.MemoryStream
        $bitmap.Save($output,[Drawing.Imaging.ImageFormat]::Png)
        @{page=$page;totalPages=$totalPages;sourceWidth=$sourceWidth;sourceHeight=$sourceHeight;width=$width;height=$height;resized=($scale -lt 1);region=$request.region;image=[Convert]::ToBase64String($output.ToArray())} | ConvertTo-Json -Depth 6 -Compress
    } finally {
        foreach ($disposable in @($graphics,$bitmap,$image,$output,$inputStream,$random,$pdfPage)) { if ($disposable) { $disposable.Dispose() } }
    }
} catch { @{error=$_.Exception.Message} | ConvertTo-Json -Compress; exit 2 }
