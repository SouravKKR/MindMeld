export function scaleDownImage(base64Image, quality, callback) 
{
    const img = new Image();
    img.onload = () => 
    {
        let width = img.width;
        let height = img.height;

        // Create a canvas to draw the scaled image
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Get the new Base64-encoded image with the specified quality
        const scaledBase64Image = canvas.toDataURL('image/jpeg', quality);
        callback(scaledBase64Image);
    };

    img.src = base64Image;

}