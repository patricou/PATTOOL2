package com.pat.service.assistant;

import com.drew.imaging.ImageMetadataReader;
import com.drew.imaging.ImageProcessingException;
import com.drew.metadata.Metadata;
import com.drew.metadata.MetadataException;
import com.drew.metadata.exif.ExifIFD0Directory;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.AffineTransform;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Iterator;

/**
 * Les JPEG téléphone sont souvent stockés en paysage au niveau pixels avec une balise EXIF
 * {@code Orientation} pour l’affichage portrait. Les navigateurs appliquent cette balise pour
 * {@code <img>}, mais les APIs vision (Gemini, etc.) décoder souvent les pixels bruts — le modèle
 * « voit » alors du paysage et les sorties image peuvent rester paysage. On réencode en JPEG avec
 * pixels déjà tournés et sans dépendre de l’EXIF pour la géométrie.
 */
public final class AssistantImageOrientationNormalizer {

    private static final float JPEG_QUALITY = 0.92f;

    private AssistantImageOrientationNormalizer() {}

    /**
     * @return {@code null} si aucun changement n’est nécessaire ou si la lecture échoue (garder les octets d’origine).
     */
    public static byte[] normalizeJpegPixelOrientation(byte[] jpegBytes) {
        if (jpegBytes == null || jpegBytes.length == 0) {
            return null;
        }
        BufferedImage raw;
        try {
            raw = ImageIO.read(new ByteArrayInputStream(jpegBytes));
        } catch (IOException e) {
            return null;
        }
        if (raw == null) {
            return null;
        }
        BufferedImage oriented = applyExifOrientation(raw, jpegBytes);
        if (oriented == raw) {
            return null;
        }
        try {
            byte[] out = writeJpeg(oriented);
            oriented.flush();
            if (oriented != raw) {
                raw.flush();
            }
            return out;
        } catch (IOException e) {
            if (oriented != raw) {
                oriented.flush();
            }
            raw.flush();
            return null;
        }
    }

    private static BufferedImage applyExifOrientation(BufferedImage image, byte[] fileBytes) {
        try {
            Metadata metadata = ImageMetadataReader.readMetadata(new ByteArrayInputStream(fileBytes));
            ExifIFD0Directory exif = metadata.getFirstDirectoryOfType(ExifIFD0Directory.class);
            if (exif == null || !exif.containsTag(ExifIFD0Directory.TAG_ORIENTATION)) {
                return image;
            }
            int orientation = exif.getInt(ExifIFD0Directory.TAG_ORIENTATION);
            return switch (orientation) {
                case 2 -> flipHorizontal(image);
                case 3 -> rotate(image, 180);
                case 4 -> flipVertical(image);
                case 5 -> transposeFlip(image); // horizontal flip + 90 CCW
                case 6 -> rotate(image, 90);
                case 7 -> antiTransposeFlip(image); // horizontal flip + 90 CW
                case 8 -> rotate(image, -90);
                default -> image;
            };
        } catch (ImageProcessingException | MetadataException | IOException e) {
            return image;
        }
    }

    private static BufferedImage rotate(BufferedImage image, double angleDeg) {
        int w = image.getWidth();
        int h = image.getHeight();
        int type = image.getType() == 0 ? BufferedImage.TYPE_INT_RGB : image.getType();

        double rad = Math.toRadians(angleDeg);
        double cos = Math.abs(Math.cos(rad));
        double sin = Math.abs(Math.sin(rad));
        int newW = (int) Math.round(w * cos + h * sin);
        int newH = (int) Math.round(h * cos + w * sin);

        BufferedImage out = new BufferedImage(newW, newH, type);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        int ox = (newW - w) / 2;
        int oy = (newH - h) / 2;
        g.translate(ox, oy);
        g.rotate(rad, w / 2.0, h / 2.0);
        g.drawImage(image, 0, 0, null);
        g.dispose();
        return out;
    }

    private static BufferedImage flipHorizontal(BufferedImage image) {
        int w = image.getWidth();
        int h = image.getHeight();
        int type = image.getType() == 0 ? BufferedImage.TYPE_INT_RGB : image.getType();
        BufferedImage out = new BufferedImage(w, h, type);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        AffineTransform tx = AffineTransform.getTranslateInstance(w, 0);
        tx.concatenate(AffineTransform.getScaleInstance(-1, 1));
        g.drawImage(image, tx, null);
        g.dispose();
        return out;
    }

    private static BufferedImage flipVertical(BufferedImage image) {
        int w = image.getWidth();
        int h = image.getHeight();
        int type = image.getType() == 0 ? BufferedImage.TYPE_INT_RGB : image.getType();
        BufferedImage out = new BufferedImage(w, h, type);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        AffineTransform tx = AffineTransform.getTranslateInstance(0, h);
        tx.concatenate(AffineTransform.getScaleInstance(1, -1));
        g.drawImage(image, tx, null);
        g.dispose();
        return out;
    }

    /** EXIF 5: mirrored along diagonal then rotated (equivalent to flip H + rot -90). */
    private static BufferedImage transposeFlip(BufferedImage image) {
        BufferedImage r = rotate(flipHorizontal(image), -90);
        return r;
    }

    /** EXIF 7: mirrored along anti-diagonal (flip H + rot 90). */
    private static BufferedImage antiTransposeFlip(BufferedImage image) {
        BufferedImage r = rotate(flipHorizontal(image), 90);
        return r;
    }

    private static byte[] writeJpeg(BufferedImage image) throws IOException {
        BufferedImage rgb =
                image.getColorModel().hasAlpha()
                        ? copyToRgb(image)
                        : ensureRgbType(image);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
        if (!writers.hasNext()) {
            throw new IOException("No JPEG writer");
        }
        ImageWriter writer = writers.next();
        ImageWriteParam params = writer.getDefaultWriteParam();
        if (params.canWriteCompressed()) {
            params.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            params.setCompressionQuality(JPEG_QUALITY);
        }
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(bos)) {
            writer.setOutput(ios);
            writer.write(null, new IIOImage(rgb, null, null), params);
        } finally {
            writer.dispose();
        }
        if (rgb != image) {
            rgb.flush();
        }
        return bos.toByteArray();
    }

    private static BufferedImage ensureRgbType(BufferedImage image) {
        if (image.getType() == BufferedImage.TYPE_INT_RGB || image.getType() == BufferedImage.TYPE_3BYTE_BGR) {
            return image;
        }
        return copyToRgb(image);
    }

    private static BufferedImage copyToRgb(BufferedImage src) {
        BufferedImage rgb =
                new BufferedImage(src.getWidth(), src.getHeight(), BufferedImage.TYPE_INT_RGB);
        Graphics2D g = rgb.createGraphics();
        g.setColor(java.awt.Color.WHITE);
        g.fillRect(0, 0, rgb.getWidth(), rgb.getHeight());
        g.drawImage(src, 0, 0, null);
        g.dispose();
        return rgb;
    }
}
