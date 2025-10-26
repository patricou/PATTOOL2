package com.pat.controller;

import com.pat.repo.domain.CategoryLink;
import com.pat.repo.CategoryLinkRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Optional;

@RestController
@RequestMapping("/api/categories")
public class CategoryLinkRestController {

    private static final Logger log = LoggerFactory.getLogger(CategoryLinkRestController.class);

    @Autowired
    CategoryLinkRepository categoryLinkRepository;

    @RequestMapping(method = RequestMethod.GET)
    public List<CategoryLink> getCategory(){
        log.info("Get categoryUrl");
        Sort sort = Sort.by(Sort.Direction.ASC, "categoryName");
        return categoryLinkRepository.findAll(sort);
    }

    @GetMapping("/{id}")
    public ResponseEntity<CategoryLink> getCategoryById(@PathVariable String id) {
        log.info("Get category by id: {}", id);
        Optional<CategoryLink> category = categoryLinkRepository.findById(id);
        return category.map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<CategoryLink> createCategory(@RequestBody CategoryLink category) {
        log.info("Create category: {}", category.getCategoryName());
        try {
            // Capitalize first letter of name
            if (category.getCategoryName() != null && !category.getCategoryName().isEmpty()) {
                String name = category.getCategoryName();
                category.setCategoryName(name.substring(0, 1).toUpperCase() + name.substring(1).toLowerCase());
            }
            
            // Capitalize first letter of description
            if (category.getCategoryDescription() != null && !category.getCategoryDescription().isEmpty()) {
                String description = category.getCategoryDescription();
                category.setCategoryDescription(description.substring(0, 1).toUpperCase() + description.substring(1).toLowerCase());
            }
            
            // Generate next categoryLinkID if needed
            if (category.getCategoryLinkID() == null || category.getCategoryLinkID().isEmpty()) {
                // Find the maximum categoryLinkID and increment by 1
                List<CategoryLink> allCategories = categoryLinkRepository.findAll();
                long maxId = 0;
                for (CategoryLink cat : allCategories) {
                    try {
                        long id = Long.parseLong(cat.getCategoryLinkID());
                        if (id > maxId) {
                            maxId = id;
                        }
                    } catch (NumberFormatException e) {
                        // Skip invalid categoryLinkID values
                    }
                }
                category.setCategoryLinkID(String.valueOf(maxId + 1));
            }
            // Don't set MongoDB _id manually, let MongoDB generate it
            category.setId(null);
            CategoryLink savedCategory = categoryLinkRepository.save(category);
            return new ResponseEntity<>(savedCategory, HttpStatus.CREATED);
        } catch (Exception e) {
            log.error("Error creating category: ", e);
            return new ResponseEntity<>(null, HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @PutMapping("/{id}")
    public ResponseEntity<CategoryLink> updateCategory(@PathVariable String id, @RequestBody CategoryLink categoryDetails) {
        log.info("Update category with id: {}", id);
        Optional<CategoryLink> categoryOptional = categoryLinkRepository.findById(id);
        
        if (categoryOptional.isPresent()) {
            CategoryLink category = categoryOptional.get();
            
            // Capitalize first letter of name if provided
            if (categoryDetails.getCategoryName() != null && !categoryDetails.getCategoryName().isEmpty()) {
                String name = categoryDetails.getCategoryName();
                category.setCategoryName(name.substring(0, 1).toUpperCase() + name.substring(1).toLowerCase());
            }
            
            // Capitalize first letter of description if provided
            if (categoryDetails.getCategoryDescription() != null && !categoryDetails.getCategoryDescription().isEmpty()) {
                String description = categoryDetails.getCategoryDescription();
                category.setCategoryDescription(description.substring(0, 1).toUpperCase() + description.substring(1).toLowerCase());
            }
            
            category.setCategoryLinkID(categoryDetails.getCategoryLinkID());
            
            CategoryLink updatedCategory = categoryLinkRepository.save(category);
            return ResponseEntity.ok(updatedCategory);
        } else {
            return ResponseEntity.notFound().build();
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<HttpStatus> deleteCategory(@PathVariable String id) {
        log.info("Delete category with id: {}", id);
        try {
            categoryLinkRepository.deleteById(id);
            return new ResponseEntity<>(HttpStatus.NO_CONTENT);
        } catch (Exception e) {
            log.error("Error deleting category: ", e);
            return new ResponseEntity<>(HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }
}
