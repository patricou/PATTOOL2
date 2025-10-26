// Script MongoDB pour ajouter le champ author à tous les categorylink
// Auteur: patricou (ID: 590091a706443312403f7c53)

// Remplacez 'your_database_name' par le nom de votre base de données
use your_database_name;

// Ajouter le champ author comme DBRef avec ObjectId à tous les documents categorylink
db.categorylink.updateMany(
  {},
  {
    $set: {
      "author": {
        "$ref": "members",
        "$id": ObjectId("590091a706443312403f7c53")
      },
      "visibility": "public"
    }
  }
);

// Vérifier le résultat
print("Nombre total de documents: " + db.categorylink.countDocuments({}));
print("Documents avec author: " + db.categorylink.countDocuments({ "author": { $exists: true } }));

// Afficher un exemple pour vérifier
print("\nExemple de document après modification:");
db.categorylink.findOne({}, { categoryName: 1, author: 1, visibility: 1 });

