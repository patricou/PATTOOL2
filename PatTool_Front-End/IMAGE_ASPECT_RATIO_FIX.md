# Fix pour le problème de perte de proportions des images portrait

## Problème
Les images compressées et redimensionnées dans le backend en mode portrait perdent leurs proportions (aspect ratio).

## Cause
Le problème se produit généralement lorsque le code backend redimensionne les images sans maintenir correctement le ratio largeur/hauteur (aspect ratio). Cela arrive souvent quand:
1. Le code force une largeur ET une hauteur spécifiques au lieu de calculer l'une en fonction de l'autre
2. Le code ne prend pas en compte l'orientation de l'image (portrait vs paysage)
3. Le code utilise des valeurs fixes sans tenir compte des proportions originales

## Solution pour le Backend Spring Boot

### Étape 1: Trouver le code de redimensionnement

Cherchez dans votre backend Spring Boot (`PatTool_Back-End`) les fichiers qui gèrent le redimensionnement d'images:
- Contrôleurs qui reçoivent les uploads de fichiers (`FileController`, `UploadController`, etc.)
- Services qui traitent les images (`ImageService`, `FileProcessingService`, etc.)
- Utilisez `BufferedImage`, `ImageIO`, ou une bibliothèque comme `Thumbnailator`

### Étape 2: Correction du code de redimensionnement

#### ❌ CODE INCORRECT (perd les proportions)
```java
// Ne PAS faire cela - force une taille spécifique
BufferedImage resized = new BufferedImage(targetWidth, targetHeight, BufferedImage.TYPE_INT_RGB);
Graphics2D g = resized.createGraphics();
g.drawImage(originalImage, 0, 0, targetWidth, targetHeight, null);
g.dispose();
```

#### ✅ CODE CORRECT (maintient les proportions)

**Option 1: Avec Java standard (BufferedImage)**
```java
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.IOException;

public BufferedImage resizeImage(BufferedImage originalImage, int maxWidth, int maxHeight) {
    // 1. Obtenir les dimensions originales
    int originalWidth = originalImage.getWidth();
    int originalHeight = originalImage.getHeight();
    
    // 2. Calculer les nouvelles dimensions en maintenant le ratio
    double widthRatio = (double) maxWidth / originalWidth;
    double heightRatio = (double) maxHeight / originalHeight;
    double ratio = Math.min(widthRatio, heightRatio); // Prendre le plus petit pour maintenir les proportions
    
    // 3. Calculer les nouvelles dimensions
    int newWidth = (int) (originalWidth * ratio);
    int newHeight = (int) (originalHeight * ratio);
    
    // 4. Créer l'image redimensionnée
    BufferedImage resized = new BufferedImage(newWidth, newHeight, BufferedImage.TYPE_INT_RGB);
    Graphics2D g = resized.createGraphics();
    
    // 5. Utiliser un rendu de qualité
    g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
    g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
    g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
    
    // 6. Dessiner l'image redimensionnée
    g.drawImage(originalImage, 0, 0, newWidth, newHeight, null);
    g.dispose();
    
    return resized;
}
```

**Option 2: Avec la bibliothèque Thumbnailator (recommandé)**

Ajoutez la dépendance dans `pom.xml`:
```xml
<dependency>
    <groupId>net.coobird</groupId>
    <artifactId>thumbnailator</artifactId>
    <version>0.4.20</version>
</dependency>
```

Code d'utilisation:
```java
import net.coobird.thumbnailator.Thumbnails;

public BufferedImage resizeImage(BufferedImage originalImage, int maxWidth, int maxHeight) throws IOException {
    return Thumbnails.of(originalImage)
        .size(maxWidth, maxHeight)  // Thumbnailator maintient automatiquement le ratio
        .asBufferedImage();
}
```

**Option 3: Avec Java ImageIO (simple)**
```java
import java.awt.Image;
import java.awt.image.BufferedImage;

public BufferedImage resizeImage(BufferedImage originalImage, int maxWidth, int maxHeight) {
    // Calculer les dimensions en maintenant le ratio
    int originalWidth = originalImage.getWidth();
    int originalHeight = originalImage.getHeight();
    
    double widthRatio = (double) maxWidth / originalWidth;
    double heightRatio = (double) maxHeight / originalHeight;
    double ratio = Math.min(widthRatio, heightRatio);
    
    int newWidth = (int) (originalWidth * ratio);
    int newHeight = (int) (originalHeight * ratio);
    
    // Utiliser Image.getScaledInstance (moins recommandé mais simple)
    Image scaledImage = originalImage.getScaledInstance(newWidth, newHeight, Image.SCALE_SMOOTH);
    
    // Convertir en BufferedImage
    BufferedImage resized = new BufferedImage(newWidth, newHeight, BufferedImage.TYPE_INT_RGB);
    Graphics2D g = resized.createGraphics();
    g.drawImage(scaledImage, 0, 0, null);
    g.dispose();
    
    return resized;
}
```

### Étape 3: Exemple complet dans un service

```java
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import javax.imageio.ImageIO;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

@Service
public class ImageProcessingService {
    
    private static final int MAX_WIDTH = 1920;
    private static final int MAX_HEIGHT = 1080;
    private static final double COMPRESSION_QUALITY = 0.85;
    
    public byte[] processAndCompressImage(MultipartFile file) throws IOException {
        // 1. Lire l'image originale
        BufferedImage originalImage = ImageIO.read(file.getInputStream());
        
        if (originalImage == null) {
            throw new IOException("Impossible de lire l'image");
        }
        
        // 2. Obtenir les dimensions originales
        int originalWidth = originalImage.getWidth();
        int originalHeight = originalImage.getHeight();
        
        // 3. Vérifier si un redimensionnement est nécessaire
        if (originalWidth <= MAX_WIDTH && originalHeight <= MAX_HEIGHT) {
            // Pas besoin de redimensionner, juste compresser
            return compressImage(originalImage, file.getContentType());
        }
        
        // 4. Calculer les nouvelles dimensions en maintenant le ratio
        double widthRatio = (double) MAX_WIDTH / originalWidth;
        double heightRatio = (double) MAX_HEIGHT / originalHeight;
        double ratio = Math.min(widthRatio, heightRatio); // CRITIQUE: utiliser Math.min
        
        int newWidth = (int) (originalWidth * ratio);
        int newHeight = (int) (originalHeight * ratio);
        
        // 5. Redimensionner en maintenant les proportions
        BufferedImage resized = resizeImageWithRatio(originalImage, newWidth, newHeight);
        
        // 6. Compresser l'image redimensionnée
        return compressImage(resized, file.getContentType());
    }
    
    private BufferedImage resizeImageWithRatio(BufferedImage original, int targetWidth, int targetHeight) {
        BufferedImage resized = new BufferedImage(targetWidth, targetHeight, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = resized.createGraphics();
        
        // Qualité de rendu optimale
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        
        g.drawImage(original, 0, 0, targetWidth, targetHeight, null);
        g.dispose();
        
        return resized;
    }
    
    private byte[] compressImage(BufferedImage image, String contentType) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        
        if (contentType != null && contentType.contains("png")) {
            ImageIO.write(image, "png", baos);
        } else {
            // JPEG avec qualité
            javax.imageio.ImageWriteParam writeParam = null;
            if (ImageIO.getImageWritersByFormatName("jpg").hasNext()) {
                javax.imageio.ImageWriter writer = ImageIO.getImageWritersByFormatName("jpg").next();
                javax.imageio.stream.ImageOutputStream ios = ImageIO.createImageOutputStream(baos);
                writer.setOutput(ios);
                
                writeParam = writer.getDefaultWriteParam();
                if (writeParam.canWriteCompressed()) {
                    writeParam.setCompressionMode(javax.imageio.ImageWriteParam.MODE_EXPLICIT);
                    writeParam.setCompressionQuality((float) COMPRESSION_QUALITY);
                }
                
                writer.write(null, new javax.imageio.IIOImage(image, null, null), writeParam);
                writer.dispose();
                ios.close();
            } else {
                ImageIO.write(image, "jpg", baos);
            }
        }
        
        return baos.toByteArray();
    }
}
```

## Points clés pour maintenir les proportions

1. **Toujours utiliser `Math.min()`** pour calculer le ratio:
   ```java
   double ratio = Math.min(widthRatio, heightRatio);
   ```
   Cela garantit que l'image rentre dans les limites sans déformation.

2. **Calculer les deux dimensions** à partir du même ratio:
   ```java
   int newWidth = (int) (originalWidth * ratio);
   int newHeight = (int) (originalHeight * ratio);
   ```

3. **NE JAMAIS fixer** à la fois width et height sans calculer le ratio:
   ```java
   // ❌ MAUVAIS
   int newWidth = 1920;
   int newHeight = 1080;
   
   // ✅ BON
   double ratio = Math.min(1920.0 / originalWidth, 1080.0 / originalHeight);
   int newWidth = (int) (originalWidth * ratio);
   int newHeight = (int) (originalHeight * ratio);
   ```

## Vérification

Après la correction, testez avec:
- Images portrait (hauteur > largeur)
- Images paysage (largeur > hauteur)
- Images carrées (largeur == hauteur)

Toutes doivent conserver leurs proportions originales après redimensionnement.

## Emplacement probable du code à modifier

Dans votre backend Spring Boot, cherchez:
1. `src/main/java/.../controller/FileController.java` ou `UploadController.java`
2. `src/main/java/.../service/FileService.java` ou `ImageService.java`
3. Méthodes contenant: `resize`, `compress`, `scale`, `thumbnail`, `BufferedImage`

## Note

Ce fix doit être appliqué dans le backend (`PatTool_Back-End`). Le frontend Angular (`PatTool_Front-End`) n'a pas besoin de modifications car il envoie simplement les fichiers au backend via FormData.

