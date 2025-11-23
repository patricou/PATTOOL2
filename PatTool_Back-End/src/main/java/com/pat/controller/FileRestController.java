package com.pat.controller;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.bson.Document;
import com.mongodb.client.gridfs.model.GridFSFile;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.FileUploaded;
import com.pat.repo.domain.Member;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.MembersRepository;
import com.pat.service.ImageCompressionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.InputStreamResource;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.gridfs.GridFsTemplate;
import org.springframework.data.mongodb.gridfs.GridFsResource;
import org.bson.types.ObjectId;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;




/**
 * Created by patricou on 5/8/2017.
 */
@RestController
public class FileRestController {

    @Value("${app.uploaddir:C:\\temp}")
    private String uploadDir;
    
    @Value("${app.imagemaxsizekb:500}")
    private int imagemaxsizekb;
    
    @Autowired
    private EvenementsRepository evenementsRepository;
    @Autowired
    private MembersRepository membersRepository;
    @Autowired
    private GridFsTemplate gridFsTemplate;
    @Autowired
    private MailController mailController;
    @Autowired
    private ImageCompressionService imageCompressionService;

    private static final Logger log = LoggerFactory.getLogger(FileRestController.class);
    
    // In-memory storage for upload session logs (thread-safe)
    private final Map<String, List<String>> uploadLogs = new ConcurrentHashMap<>();

    @RequestMapping( value = "/api/file/test", method = RequestMethod.GET )
    public ResponseEntity<String> testFileEndpoint(){
        
        log.debug("Testing file endpoint configuration");
        
        try {
            if (gridFsTemplate == null) {
                return ResponseEntity.ok("GridFsTemplate is null - MongoDB GridFS not configured");
            }
            
            return ResponseEntity.ok("GridFsTemplate is available - MongoDB GridFS configured");
        } catch (Exception e) {
            log.debug("Error testing file endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }
    
    /**
     * Get upload logs (REST endpoint for polling)
     */
    @GetMapping(value = "/api/file/upload-logs/{sessionId}")
    public ResponseEntity<List<String>> getUploadLogs(@PathVariable String sessionId) {
        List<String> logs = uploadLogs.getOrDefault(sessionId, Collections.emptyList());
        return ResponseEntity.ok()
            .header(HttpHeaders.CACHE_CONTROL, "no-cache, no-store, must-revalidate")
            .header(HttpHeaders.PRAGMA, "no-cache")
            .header(HttpHeaders.EXPIRES, "0")
            .body(logs);
    }
    
    /**
     * Helper method to add log to session
     */
    private void addUploadLog(String sessionId, String message) {
        uploadLogs.computeIfAbsent(sessionId, k -> Collections.synchronizedList(new ArrayList<>()))
                  .add(message);
    }
    
    /**
     * Clear logs for a session
     */
    private void clearUploadLogs(String sessionId) {
        uploadLogs.remove(sessionId);
    }

    @RequestMapping( value = "/api/file/debug/{fileId}", method = RequestMethod.GET )
    public ResponseEntity<String> debugFileEndpoint(@PathVariable String fileId){
        
        log.debug("Debug file endpoint for ID: " + fileId);
        
        try {
            if (gridFsTemplate == null) {
                return ResponseEntity.ok("GridFsTemplate is null");
            }
            
            // Validate ObjectId format
            ObjectId objectId;
            try {
                objectId = new ObjectId(fileId);
                log.debug("ObjectId validation passed: " + objectId);
            } catch (IllegalArgumentException e) {
                return ResponseEntity.ok("Invalid ObjectId format: " + fileId + " - " + e.getMessage());
            }
            
            // Try to get resource
            try {
                GridFsResource gridFsResource = gridFsTemplate.getResource(fileId);
                if (gridFsResource == null) {
                    return ResponseEntity.ok("GridFsResource is null for ID: " + fileId);
                } else {
                    return ResponseEntity.ok("GridFsResource found - Filename: " + gridFsResource.getFilename() + 
                                           ", ContentType: " + gridFsResource.getContentType() + 
                                           ", Length: " + gridFsResource.contentLength());
                }
            } catch (IllegalStateException e) {
                return ResponseEntity.ok("IllegalStateException: " + e.getMessage());
            }
            
        } catch (Exception e) {
            log.debug("Error in debug endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }

    @RequestMapping( value = "/api/file/list", method = RequestMethod.GET )
    public ResponseEntity<String> listFilesEndpoint(){
        
        log.debug("List files endpoint");
        
        try {
            if (gridFsTemplate == null) {
                return ResponseEntity.ok("GridFsTemplate is null");
            }
            
            StringBuilder result = new StringBuilder();
            result.append("GridFS Files List:\n");
            result.append("==================\n");
            
            // Try to find any files in GridFS
            try {
                // This will help us see what files actually exist
                result.append("Note: This endpoint lists files in the current GridFS bucket.\n");
                result.append("If your file exists but is not listed here, it might be in:\n");
                result.append("- A different MongoDB database\n");
                result.append("- A different GridFS bucket\n");
                result.append("- A different collection structure\n\n");
                
                result.append("Current MongoDB connection: 192.168.1.39:27017\n");
                result.append("Current database: rando (from application.properties)\n");
                result.append("GridFS bucket: fs (default)\n\n");
                
                result.append("To verify file existence, you can:\n");
                result.append("1. Connect to MongoDB directly using MongoDB Compass\n");
                result.append("2. Check database: rando\n");
                result.append("3. Check collections: fs.files and fs.chunks\n");
                result.append("4. Search for ObjectId: ").append("6847177c50b5ef3eb05f59b3").append("\n");
                
            } catch (Exception e) {
                result.append("Error listing files: ").append(e.getMessage()).append("\n");
            }
            
            return ResponseEntity.ok(result.toString());
            
        } catch (Exception e) {
            log.debug("Error in list endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }

    @RequestMapping( value = "/api/file/search/{fileId}", method = RequestMethod.GET )
    public ResponseEntity<String> searchFileEndpoint(@PathVariable String fileId){
        
        log.debug("Search file endpoint for ID: " + fileId);
        
        try {
            if (gridFsTemplate == null) {
                return ResponseEntity.ok("GridFsTemplate is null");
            }
            
            StringBuilder result = new StringBuilder();
            result.append("Searching for file ID: ").append(fileId).append("\n");
            
            // Validate ObjectId format
            ObjectId objectId;
            try {
                objectId = new ObjectId(fileId);
                result.append("✓ ObjectId validation passed: ").append(objectId).append("\n");
            } catch (IllegalArgumentException e) {
                return ResponseEntity.ok("Invalid ObjectId format: " + fileId + " - " + e.getMessage());
            }
            
            // Try different approaches to find the file
            result.append("\n--- Search Methods ---\n");
            
            // Method 1: Direct getResource with string
            try {
                GridFsResource resource1 = gridFsTemplate.getResource(fileId);
                if (resource1 != null) {
                    result.append("✓ Method 1 (getResource with string): FOUND\n");
                    result.append("  Filename: ").append(resource1.getFilename()).append("\n");
                    result.append("  ContentType: ").append(resource1.getContentType()).append("\n");
                    result.append("  Length: ").append(resource1.contentLength()).append("\n");
                } else {
                    result.append("✗ Method 1 (getResource with string): NOT FOUND\n");
                }
            } catch (IllegalStateException e) {
                result.append("✗ Method 1 (getResource with string): ").append(e.getMessage()).append("\n");
            }
            
            // Method 2: Try with ObjectId
            try {
                GridFsResource resource2 = gridFsTemplate.getResource(objectId.toString());
                if (resource2 != null) {
                    result.append("✓ Method 2 (getResource with ObjectId string): FOUND\n");
                    result.append("  Filename: ").append(resource2.getFilename()).append("\n");
                    result.append("  ContentType: ").append(resource2.getContentType()).append("\n");
                    result.append("  Length: ").append(resource2.contentLength()).append("\n");
                } else {
                    result.append("✗ Method 2 (getResource with ObjectId string): NOT FOUND\n");
                }
            } catch (IllegalStateException e) {
                result.append("✗ Method 2 (getResource with ObjectId string): ").append(e.getMessage()).append("\n");
            }
            
            // Method 3: Check GridFS status
            try {
                result.append("\n--- GridFS Status ---\n");
                result.append("GridFsTemplate is available and configured\n");
                result.append("File ID format: ").append(fileId).append(" (24 characters)\n");
                result.append("ObjectId format: ").append(objectId.toString()).append("\n");
            } catch (Exception e) {
                result.append("Error getting GridFS info: ").append(e.getMessage()).append("\n");
            }
            
            return ResponseEntity.ok(result.toString());
            
        } catch (Exception e) {
            log.debug("Error in search endpoint", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body("Error: " + e.getMessage());
        }
    }

    @RequestMapping( value = "/api/file/{fileId}", method = RequestMethod.GET )
    public ResponseEntity< InputStreamResource> getFile(@PathVariable String fileId, HttpServletRequest request, HttpServletResponse response){
        
        log.debug("Attempting to retrieve file with ID: " + fileId);

        try {
            // Check if GridFsTemplate is available
            if (gridFsTemplate == null) {
                log.debug("GridFsTemplate is null - MongoDB GridFS not properly configured");
                return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("GridFS not configured".getBytes())));
            }

            // Convert string ID to ObjectId for validation
            ObjectId objectId;
            try {
                objectId = new ObjectId(fileId);
            } catch (IllegalArgumentException e) {
                log.debug("Invalid ObjectId format: " + fileId, e);
                return ResponseEntity.badRequest()
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("Invalid file ID format".getBytes())));
            }
            
            // Try to find the file by ObjectId using findOne
            GridFSFile gridFsFile = gridFsTemplate.findOne(new Query(Criteria.where("_id").is(objectId)));
            
            if (gridFsFile == null) {
                log.debug("File not found: " + fileId);
                return ResponseEntity.notFound().build();
            }
            
            // Get the resource from the found file
            GridFsResource gridFsResource = gridFsTemplate.getResource(gridFsFile);

            HttpHeaders headers = new HttpHeaders();
            
            // Handle content type with fallback for missing metadata
            String contentType;
            try {
                contentType = gridFsResource.getContentType();
                if (contentType == null || contentType.isEmpty()) {
                    // Fallback to application/octet-stream if no content type is available
                    contentType = "application/octet-stream";
                    log.debug("No content type found for file: " + fileId + ", using fallback: " + contentType);
                }
            } catch (com.mongodb.MongoGridFSException e) {
                // Specifically handle the "No contentType data" exception
                // Try to determine content type from filename extension
                String filename = gridFsResource.getFilename();
                contentType = getContentTypeFromFilename(filename);
                log.debug("No content type metadata for file: " + fileId + " (" + filename + "), determined type: " + contentType);
            } catch (Exception e) {
                log.debug("Error getting content type for file: " + fileId + ", using fallback", e);
                contentType = "application/octet-stream";
            }
            
            headers.setContentType(MediaType.parseMediaType(contentType));
            
            // Handle filename with fallback
            String filename = gridFsResource.getFilename();
            if (filename == null || filename.isEmpty()) {
                filename = "file_" + fileId; // Fallback filename
                log.debug("No filename found for file: " + fileId + ", using fallback: " + filename);
            }
            
            log.debug("Request file " + filename);
            headers.setContentDispositionFormData(filename, filename);
            headers.set("Content-Disposition","inline; filename =" + filename);
            
            try {
                // Handle content length with fallback
                long contentLength = -1; // -1 indicates unknown length
                try {
                    contentLength = gridFsResource.contentLength();
                    if (contentLength > 0) {
                        headers.set("Content-Length", Long.toString(contentLength));
                    }
                } catch (Exception e) {
                    log.debug("Could not determine content length for file: " + fileId, e);
                }
                
                // No resizing - return original image as-is
                // Enrich response with size/EXIF headers (consumed by the front-end)
                long originalSizeForHeader = contentLength > 0 ? contentLength : -1;
                if (originalSizeForHeader <= 0) {
                    try {
                        originalSizeForHeader = gridFsResource.contentLength();
                    } catch (Exception ignore) { }
                }
                if (originalSizeForHeader > 0) {
                    headers.set("X-Pat-Image-Size-Before", Long.toString(originalSizeForHeader));
                    long kb = Math.max(1, originalSizeForHeader / 1024);
                    headers.set("X-Pat-Exif", "PatOriginalFileSizeBytes=" + originalSizeForHeader + "; PatOriginalFileSizeKB=" + kb);
                }
                // Make sure custom headers are readable by browsers (CORS)
                headers.set("Access-Control-Expose-Headers", "X-Pat-Compression, X-Pat-Image-Size-Before, X-Pat-Image-Size-After, X-Pat-Exif");
                
                // Check if client connection is still open before returning response
                // This helps prevent AsyncRequestNotUsableException when client closes connection
                if (request != null && !response.isCommitted()) {
                    try {
                        // Check if output stream is available
                        response.getOutputStream();
                    } catch (IOException e) {
                        // Connection closed by client - log at debug level and return null
                        if (e.getMessage() != null && (e.getMessage().contains("Connection reset") || 
                                                         e.getMessage().contains("Broken pipe"))) {
                            log.debug("Client closed connection before file transfer completed for file: " + fileId);
                            return null; // Connection already closed, can't send response
                        }
                        throw e; // Re-throw if it's a different IOException
                    }
                }
                
                return ResponseEntity.ok()
                        .headers(headers)
                        .body(new InputStreamResource(gridFsResource.getInputStream()));
            } catch (IOException e) {
                // Handle connection reset gracefully - this is normal when client closes modal/slideshow
                String errorMsg = e.getMessage();
                if (errorMsg != null && (errorMsg.contains("Connection reset") || 
                                         errorMsg.contains("Broken pipe") ||
                                         errorMsg.contains("Connection closed"))) {
                    log.debug("Client closed connection during file transfer for file: " + fileId);
                    return null; // Connection already closed, can't send response
                }
                
                log.debug("Error accessing file content: " + fileId, e);
                return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(new InputStreamResource(new java.io.ByteArrayInputStream("Error accessing file content".getBytes())));
            }
        } catch (IllegalStateException e) {
            log.debug("File does not exist: " + fileId + " - " + e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (com.mongodb.MongoGridFSException e) {
            log.debug("GridFS error for file: " + fileId + " - " + e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new InputStreamResource(new java.io.ByteArrayInputStream(("GridFS error: " + e.getMessage()).getBytes())));
        } catch (Exception e) {
            // Check if wrapped IOException is a connection reset
            Throwable cause = e.getCause();
            if (cause instanceof IOException) {
                String causeMsg = cause.getMessage();
                if (causeMsg != null && (causeMsg.contains("Connection reset") || 
                                         causeMsg.contains("Broken pipe"))) {
                    log.debug("Client closed connection (wrapped IOException) for file: " + fileId);
                    return null; // Connection already closed
                }
            }
            
            log.debug("Error retrieving file: " + fileId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new InputStreamResource(new java.io.ByteArrayInputStream(("Error: " + e.getMessage()).getBytes())));
        }
    }


    @PostMapping({"/uploadondisk", "/uploadondisk/"})
    public ResponseEntity<String> handleFileUpload(@RequestParam("files") MultipartFile[] files, 
                                                   @RequestParam(value = "allowOriginal", required = false, defaultValue = "false") boolean allowOriginal,
                                                   HttpServletRequest request) {

        LocalDate date = LocalDate.now();

        // Create a formatter
        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy_MM_dd");
        Integer year = date.getYear();

        // Format the LocalDateTime object using the formatter
        String formattedDate = date.format(formatter);

        String dir  = uploadDir + year + File.separator+formattedDate+"_from_uploaded";
        log.debug("Dir : " +dir);


        for (MultipartFile file : files) {

                if (!file.isEmpty()) {
                    try {
                        
                        String contentType = file.getContentType();
                        long fileSize = file.getSize();
                        long maxSizeInBytes = imagemaxsizekb * 1024L; // Convert KB to bytes
                        
                        byte[] fileBytesToWrite;
                        
                        // ALWAYS compress images unless allowOriginal is explicitly set to true (O button upload)
                        // This ensures non-compressed photos can only be uploaded via the O button path
                        if (imageCompressionService.isImageType(contentType) && !allowOriginal) {
                            log.debug("Image detected for disk upload: {} bytes, compressing... (allowOriginal={})", fileSize, allowOriginal);
                            
                            try {
                                // Read entire file into byte array
                                byte[] fileBytes = file.getBytes();
                                
                                // Read the image from bytes
                                BufferedImage originalImage = ImageIO.read(new ByteArrayInputStream(fileBytes));
                                if (originalImage != null) {
                                    // Compress the image
                                    ImageCompressionService.CompressionResult compressionResult = imageCompressionService.resizeImageIfNeeded(
                                        file.getOriginalFilename(), 
                                        originalImage, 
                                        contentType, 
                                        fileSize, 
                                        maxSizeInBytes,
                                        fileBytes,
                                        null
                                    );
                                    byte[] compressedBytes = compressionResult.getData();
                                    fileBytesToWrite = compressedBytes;
                                    log.debug("Image compressed from {} to {} bytes", fileSize, compressionResult.getCompressedSize());
                                } else {
                                    // ImageIO couldn't read it, use original bytes
                                    fileBytesToWrite = fileBytes;
                                    log.debug("Could not read image with ImageIO, using original");
                                }
                            } catch (Exception e) {
                                log.debug("Error compressing image: {}, using original", e.getMessage());
                                fileBytesToWrite = file.getBytes();
                            }
                        } else if (imageCompressionService.isImageType(contentType) && allowOriginal) {
                            // O button upload path: allow non-compressed upload
                            log.debug("O button upload: Allowing original quality image upload ({} bytes)", fileSize);
                            fileBytesToWrite = file.getBytes();
                        } else {
                            // Non-image file: use original
                            fileBytesToWrite = file.getBytes();
                        }

                        Path uploadPath = Paths.get(dir);

                        if (!Files.exists(uploadPath)) {
                            Files.createDirectories(uploadPath);
                        }

                        Path filePath = uploadPath.resolve(file.getOriginalFilename());
                        Files.write(filePath, fileBytesToWrite);

                        // log.info("File Uploaded : " + filePath + " Successfully");

                        String ipAddress = request.getHeader("X-Forwarded-For");
                        if (ipAddress == null) {
                            ipAddress = request.getRemoteAddr();
                        }

                        String subject = "Upload Photo on Disk " + filePath.getFileName();
                        String body = subject + "\n" + " from IP : " + ipAddress;
                        body = body + "\n\nHeader : ";

                        Enumeration<String> headerNames = request.getHeaderNames();
                        
                        while (headerNames.hasMoreElements()) {
                            String headerName = headerNames.nextElement();
                            String headerValue = request.getHeader(headerName);

                            ObjectMapper objectMapper = new ObjectMapper();

                            if ("user".equals(headerName.toString())){
                                try{
                                    Member user = objectMapper.readValue(headerValue, Member.class);
                                    subject = subject + " from : "+ user.getUserName() + " ( " + user.getFirstName()+" "+user.getLastName()+" )";
                                }catch(JsonProcessingException je){
                                    log.debug("Issue to Unwrap user : " + je.getMessage());
                                }
                            }

                            if (! "authorization".equals(headerName.toString()) )
                                body = body + "\n" + headerName + " : "+ headerValue;
                        }

                        mailController.sendMailWithAttachement(subject,body,filePath.toString());


                    } catch (IOException e) {
                        log.debug("File Exception : " + e.getMessage());
                        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body("File Upload error : " + e.getMessage());
                    }
                }
            }
        return ResponseEntity.ok("Upload successful");
    }

    @RequestMapping( value = "/uploadfile/{userId}/{evenementid}", method = RequestMethod.POST, consumes = "multipart/form-data")
    // Important note : the name associate with RequestParam is 'file' --> seen in the browser network request.
    public ResponseEntity<List<FileUploaded>> postFile(@RequestParam("file") MultipartFile[] files, 
                                                        @RequestParam(value = "sessionId", required = false) String sessionId,
                                                        @RequestParam(value = "allowOriginal", required = false, defaultValue = "false") boolean allowOriginal,
                                                        @PathVariable String userId, 
                                                        @PathVariable String evenementid  ){
        // Clean sessionId if it contains duplicates (comma-separated)
        String cleanSessionId = sessionId;
        if (sessionId != null && sessionId.contains(",")) {
            cleanSessionId = sessionId.split(",")[0].trim();
        }
        
        // Make a final variable for use in lambdas
        final String finalSessionId = cleanSessionId;
        
        // Initialize session logs if sessionId provided
        if (finalSessionId != null && !finalSessionId.isEmpty()) {
            uploadLogs.computeIfAbsent(finalSessionId, k -> Collections.synchronizedList(new ArrayList<>()));
            addUploadLog(finalSessionId, String.format("📤 Processing %d file(s)", files.length));
        }
        
        List<FileUploaded> uploadedFiles = new ArrayList<>();
        
        try {
            Member uploaderMember = membersRepository.findById(userId).orElse(null);
            if (uploaderMember == null) {
                log.debug("User not found: " + userId);
                return new ResponseEntity<>(null, null, HttpStatus.BAD_REQUEST);
            }

            // Find the evenement
            Evenement evenement = evenementsRepository.findById(evenementid).orElse(null);
            if (evenement == null) {
                log.debug("Evenement not found: " + evenementid);
                return new ResponseEntity<>(null, null, HttpStatus.BAD_REQUEST);
            }

            // Process each file
            for (int fileIndex = 0; fileIndex < files.length; fileIndex++) {
                MultipartFile filedata = files[fileIndex];
                if (filedata.isEmpty()) {
                    log.debug("Skipping empty file");
                    continue;
                }

                if (finalSessionId != null) {
                    addUploadLog(finalSessionId, String.format("📄 Processing file %d/%d: %s (%d KB)", 
                        fileIndex + 1, files.length, filedata.getOriginalFilename(), filedata.getSize() / 1024));
                }

                // Use modern Document API instead of deprecated DBObject
                Document metaData = new Document();
                metaData.put("UploaderName", uploaderMember.getFirstName()+" "+uploaderMember.getLastName());
                metaData.put("UploaderId", uploaderMember.getId());

                // Check if file is an image
                String contentType = filedata.getContentType();
                long fileSize = filedata.getSize();
                long maxSizeInBytes = imagemaxsizekb * 1024L; // Convert KB to bytes
                
                java.io.InputStream inputStream;
                
                // ALWAYS compress images unless allowOriginal is explicitly set to true (O button upload)
                // This ensures non-compressed photos can only be uploaded via the O button path
                if (imageCompressionService.isImageType(contentType) && !allowOriginal) {
                    if (finalSessionId != null) {
                        addUploadLog(finalSessionId, String.format("⚙️ Image detected (%d KB) - Compression in progress... (allowOriginal=%s)", 
                            fileSize / 1024, allowOriginal));
                    }
                    
                    try {
                        // Read entire file into byte array (needed for both ImageIO and fallback)
                        byte[] fileBytes = filedata.getBytes();
                        
                        // Read the image from bytes
                        BufferedImage originalImage = ImageIO.read(new ByteArrayInputStream(fileBytes));
                        if (originalImage != null) {
                            if (finalSessionId != null) {
                                addUploadLog(finalSessionId, String.format("🖼️ Starting image compression for: %s", 
                                    filedata.getOriginalFilename()));
                            }
                            
                            // Compress the image
                            ImageCompressionService.CompressionResult compressionResult = imageCompressionService.resizeImageIfNeeded(
                                filedata.getOriginalFilename(), 
                                originalImage, 
                                contentType, 
                                fileSize, 
                                maxSizeInBytes,
                                fileBytes,
                                finalSessionId != null ? message -> addUploadLog(finalSessionId, message) : null
                            );
                            
                            // Create input stream from compressed bytes
                            byte[] compressedBytes = compressionResult.getData();
                            inputStream = new ByteArrayInputStream(compressedBytes);
                            if (finalSessionId != null) {
                                addUploadLog(finalSessionId, String.format("✅ Compression completed: %d KB → %d KB", 
                                    fileSize / 1024, compressionResult.getCompressedSize() / 1024));
                            }
                            log.debug("Image compressed from {} to {} bytes", fileSize, compressionResult.getCompressedSize());
                        } else {
                            // ImageIO couldn't read it, use original bytes
                            inputStream = new ByteArrayInputStream(fileBytes);
                            log.debug("Could not read image with ImageIO, using original");
                        }
                    } catch (Exception e) {
                        if (finalSessionId != null) {
                            addUploadLog(finalSessionId, "⚠️ Compression error, using original file");
                        }
                        log.debug("Error compressing image: {}, using original", e.getMessage());
                        inputStream = new ByteArrayInputStream(filedata.getBytes());
                    }
                } else if (imageCompressionService.isImageType(contentType) && allowOriginal) {
                    // O button upload path: allow non-compressed upload
                    if (finalSessionId != null) {
                        addUploadLog(finalSessionId, String.format("✓ O button upload: Allowing original quality image (%d KB)", fileSize / 1024));
                    }
                    log.debug("O button upload: Allowing original quality image upload ({} bytes)", fileSize);
                    inputStream = filedata.getInputStream();
                } else {
                    // Non-image file: use original
                    if (finalSessionId != null && imageCompressionService.isImageType(contentType)) {
                        addUploadLog(finalSessionId, String.format("✓ Image OK, no compression needed (%d KB)", fileSize / 1024));
                    }
                    inputStream = filedata.getInputStream();
                }

                // Determine correct content type from filename (more reliable than browser's contentType)
                String correctContentType = getContentTypeFromFilename(filedata.getOriginalFilename());
                // Use browser's contentType if it's valid, otherwise use filename-based detection
                if (contentType == null || contentType.isEmpty() || contentType.equals("application/octet-stream")) {
                    contentType = correctContentType;
                } else {
                    // Validate browser's contentType matches the file extension
                    String browserType = contentType.toLowerCase();
                    String filenameType = correctContentType.toLowerCase();
                    // If they don't match, prefer filename-based detection for images and videos
                    if ((browserType.startsWith("image/") && !filenameType.startsWith("image/")) ||
                        (browserType.startsWith("video/") && !filenameType.startsWith("video/"))) {
                        log.warn("ContentType mismatch for file {}: browser says {}, filename suggests {}. Using filename-based type.",
                                filedata.getOriginalFilename(), contentType, correctContentType);
                        contentType = correctContentType;
                    }
                }

                // Save the doc ( all type ) in  MongoDB
                String fieldId =
                        gridFsTemplate.store( inputStream, filedata.getOriginalFilename(), contentType, metaData).toString();
                log.debug("Doc created id : "+fieldId + " with contentType: " + contentType);

                // create the file info with correct content type
                FileUploaded fileUploaded = new FileUploaded(fieldId, filedata.getOriginalFilename(), contentType, uploaderMember);
                uploadedFiles.add(fileUploaded);
                
                // Add file to evenement
                evenement.getFileUploadeds().add(fileUploaded);
            }

            // Save the evenement updated with all files
            Evenement eventSaved = evenementsRepository.save(evenement);
            log.debug("Evenement saved with " + uploadedFiles.size() + " files");

            if (finalSessionId != null) {
                addUploadLog(finalSessionId, String.format("✅ Upload completed! %d file(s) saved", uploadedFiles.size()));
                // Clean up logs after 5 seconds
                new Thread(() -> {
                    try {
                        Thread.sleep(5000);
                        clearUploadLogs(finalSessionId);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }).start();
            }

            HttpHeaders httpHeaders = new HttpHeaders();
            httpHeaders.setLocation(ServletUriComponentsBuilder
                    .fromCurrentRequest().path("/{id}")
                    .buildAndExpand(eventSaved.getId()).toUri());

            return new ResponseEntity<List<FileUploaded>>(uploadedFiles, httpHeaders, HttpStatus.CREATED);

        }catch (Exception e ){
            log.debug(" Exception error " + e);
        }

        return new ResponseEntity<>(null,null,HttpStatus.INTERNAL_SERVER_ERROR);

    }

    @RequestMapping( value = "/api/file", method = RequestMethod.PUT )
    public ResponseEntity<Evenement> updateFile(@RequestBody Evenement evenement){

        log.debug("Update file for evenement " + evenement.getId());

        // retrieve the evenement id ( with file to delete )
        Evenement evenementNotUpdated = evenementsRepository.findById(evenement.getId()).orElse(null);
        
        if (evenementNotUpdated == null) {
            log.error("Evenement not found: " + evenement.getId());
            return new ResponseEntity<>(HttpStatus.NOT_FOUND);
        }

        // Find all files that were removed (files in old event but not in new event)
        List<FileUploaded> filesToDelete = evenementNotUpdated.getFileUploadeds().stream()
            .filter(fileUploaded -> {
                // Check if this file still exists in the updated event
                boolean stillExists = evenement.getFileUploadeds().stream()
                    .anyMatch(fileUploaded2 -> fileUploaded.getFieldId().equals(fileUploaded2.getFieldId()));
                return !stillExists; // Return true if file was removed
            })
            .collect(java.util.stream.Collectors.toList());

        log.debug("Files to delete from GridFS: " + filesToDelete.size());

        // update the evenement without the files ( the save erase all )
        Evenement savedEvenement = evenementsRepository.save(evenement);

        // delete all removed files from MongoDB GridFS
        for (FileUploaded f : filesToDelete) {
            String fileName = f.getFileName() != null ? f.getFileName() : "unknown";
            String fileId = f.getFieldId();
            
            // Check if it's a video file
            boolean isVideo = isVideoFile(fileName);
            String fileType = isVideo ? "VIDEO" : "FILE";
            
            log.info("🗑️  [{}] Starting deletion from GridFS: ID={}, Name={}", fileType, fileId, fileName);
            
            try {
                ObjectId fileObjectId = new ObjectId(fileId);
                
                // Check if file exists before deletion
                GridFSFile fileToDelete = gridFsTemplate.findOne(new Query(Criteria.where("_id").is(fileObjectId)));
                if (fileToDelete != null) {
                    long fileSize = fileToDelete.getLength();
                    String contentType = fileToDelete.getMetadata() != null ? 
                        fileToDelete.getMetadata().getString("contentType") : "unknown";
                    
                    log.info("📋 [{}] File found in GridFS - Size: {} bytes, ContentType: {}", 
                            fileType, fileSize, contentType);
                    
                    // Delete the file
                    gridFsTemplate.delete(new Query(Criteria.where("_id").is(fileObjectId)));
                    
                    log.info("✅ [{}] Successfully deleted from GridFS: ID={}, Name={}, Size={} bytes", 
                            fileType, fileId, fileName, fileSize);
                } else {
                    log.warn("⚠️  [{}] File not found in GridFS (may already be deleted): ID={}, Name={}", 
                            fileType, fileId, fileName);
                }
            } catch (IllegalArgumentException e) {
                log.error("❌ [{}] Invalid ObjectId format for file deletion: ID={}, Name={}", 
                        fileType, fileId, fileName, e);
                // Try with string ID as fallback
                try {
                    GridFSFile fileToDelete = gridFsTemplate.findOne(new Query(Criteria.where("_id").is(fileId)));
                    if (fileToDelete != null) {
                        gridFsTemplate.delete(new Query(Criteria.where("_id").is(fileId)));
                        log.info("✅ [{}] Deleted from GridFS using string ID: ID={}, Name={}", 
                                fileType, fileId, fileName);
                    } else {
                        log.warn("⚠️  [{}] File not found in GridFS (string ID): ID={}, Name={}", 
                                fileType, fileId, fileName);
                    }
                } catch (Exception e2) {
                    log.error("❌ [{}] Error deleting file from GridFS with string ID: ID={}, Name={}", 
                            fileType, fileId, fileName, e2);
                }
            } catch (Exception e) {
                log.error("❌ [{}] Error deleting file from GridFS: ID={}, Name={}", 
                        fileType, fileId, fileName, e);
                // Continue with other files - the file reference is already removed from the event
            }
        }
        
        if (!filesToDelete.isEmpty()) {
            long videoCount = filesToDelete.stream()
                .filter(f -> isVideoFile(f.getFileName()))
                .count();
            long otherFilesCount = filesToDelete.size() - videoCount;
            
            log.info("📊 Deletion summary: {} total file(s) processed - {} video(s), {} other file(s)", 
                    filesToDelete.size(), videoCount, otherFilesCount);
        }

        // return the evenement
        HttpHeaders httpHeaders = new HttpHeaders();
        httpHeaders.setLocation(ServletUriComponentsBuilder
                .fromCurrentRequest().path("/{id}")
                .buildAndExpand(evenement.getId()).toUri());

        return new ResponseEntity<Evenement>(savedEvenement, httpHeaders, HttpStatus.CREATED);

    }

    /**
     * Check if a file is a video based on its filename
     */
    private boolean isVideoFile(String filename) {
        if (filename == null || filename.isEmpty()) {
            return false;
        }
        
        String extension = filename.toLowerCase();
        return extension.endsWith(".mp4") ||
               extension.endsWith(".webm") ||
               extension.endsWith(".ogg") ||
               extension.endsWith(".ogv") ||
               extension.endsWith(".mov") ||
               extension.endsWith(".avi") ||
               extension.endsWith(".mkv") ||
               extension.endsWith(".flv") ||
               extension.endsWith(".wmv") ||
               extension.endsWith(".m4v") ||
               extension.endsWith(".3gp");
    }

    /**
     * Helper method to determine content type from filename extension
     */
    private String getContentTypeFromFilename(String filename) {
        if (filename == null || filename.isEmpty()) {
            return "application/octet-stream";
        }
        
        String extension = filename.toLowerCase();
        if (extension.endsWith(".jpg") || extension.endsWith(".jpeg")) {
            return "image/jpeg";
        } else if (extension.endsWith(".png")) {
            return "image/png";
        } else if (extension.endsWith(".gif")) {
            return "image/gif";
        } else if (extension.endsWith(".bmp")) {
            return "image/bmp";
        } else if (extension.endsWith(".webp")) {
            return "image/webp";
        } else if (extension.endsWith(".svg")) {
            return "image/svg+xml";
        } else if (extension.endsWith(".pdf")) {
            return "application/pdf";
        } else if (extension.endsWith(".txt")) {
            return "text/plain";
        } else if (extension.endsWith(".html") || extension.endsWith(".htm")) {
            return "text/html";
        } else if (extension.endsWith(".css")) {
            return "text/css";
        } else if (extension.endsWith(".js")) {
            return "application/javascript";
        } else if (extension.endsWith(".json")) {
            return "application/json";
        } else if (extension.endsWith(".xml")) {
            return "application/xml";
        } else if (extension.endsWith(".zip")) {
            return "application/zip";
        } else if (extension.endsWith(".mp4")) {
            return "video/mp4";
        } else if (extension.endsWith(".webm")) {
            return "video/webm";
        } else if (extension.endsWith(".ogg") || extension.endsWith(".ogv")) {
            return "video/ogg";
        } else if (extension.endsWith(".mov")) {
            return "video/quicktime";
        } else if (extension.endsWith(".avi")) {
            return "video/x-msvideo";
        } else if (extension.endsWith(".mkv")) {
            return "video/x-matroska";
        } else if (extension.endsWith(".flv")) {
            return "video/x-flv";
        } else if (extension.endsWith(".wmv")) {
            return "video/x-ms-wmv";
        } else if (extension.endsWith(".m4v")) {
            return "video/x-m4v";
        } else if (extension.endsWith(".3gp")) {
            return "video/3gpp";
        } else if (extension.endsWith(".mp3")) {
            return "audio/mpeg";
        } else if (extension.endsWith(".wav")) {
            return "audio/wav";
        } else {
            return "application/octet-stream";
        }
    }

}
